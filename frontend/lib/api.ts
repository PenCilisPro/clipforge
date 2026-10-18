import { createClient } from "@/lib/supabase/client";

export const API_URL =
  process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

/** Error carrying the HTTP status, so callers can react to e.g. a real 404
 *  instead of treating every failure the same. */
export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

/**
 * Fetch the Express backend with the caller's Firebase ID token attached.
 * Two self-healing retry paths keep transient failures out of the UI:
 *
 * - Transport failures (fetch rejects with TypeError, e.g. the backend
 *   briefly restarting on Northflank) are retried with backoff on idempotent
 *   requests so a transient blip doesn't surface as a hard error.
 * - A 401 means the backend rejected THIS token. The usual causes: the token
 *   expired while the tab was suspended, or the backend just stamped admin
 *   custom claims — setCustomUserClaims invalidates every ID token issued
 *   before it, even though the client's cached copy is not expired yet. The
 *   Firebase SDK only rotates the token on its own schedule (up to ~1h), so
 *   without this retry a status poller can spam 401s the whole time. Force-
 *   refresh once and retry; a 401 response means the request never executed
 *   server-side, so the retry is safe for any method.
 */
export async function apiFetch<T = unknown>(
  path: string,
  options: { method?: string; body?: unknown } = {}
): Promise<T> {
  const supabase = createClient();

  const method = options.method ?? "GET";
  const isIdempotent = method === "GET" || method === "HEAD";
  const maxAttempts = isIdempotent ? 3 : 1;

  let res!: Response;
  let attempt = 0;
  let refreshedOn401 = false;

  while (true) {
    attempt++;
    const session = (await supabase.auth.getSession()).data.session;
    if (!session) throw new Error("Not signed in");

    try {
      res = await fetch(`${API_URL}${path}`, {
        method,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
        },
        body: options.body ? JSON.stringify(options.body) : undefined,
      });
    } catch (err) {
      // Only genuine transport failures throw here; HTTP error statuses
      // don't. Retrying won't help a dead connection pattern, but a
      // single missed response during a backend restart resolves itself.
      if (attempt >= maxAttempts) throw err;
      await new Promise((r) => setTimeout(r, 500 * attempt * attempt));
      continue;
    }

    if (res.status === 401 && !refreshedOn401) {
      refreshedOn401 = true;
      try {
        // getIdToken(true) — bypass the cached token entirely.
        await supabase.auth.refreshSession();
      } catch {
        // Refresh itself failed — fall through and surface the 401.
      }
      continue;
    }
    break;
  }

  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    try {
      const data = await res.json();
      if (data?.error) message = data.error;
      // The auth middleware attaches the firebase error code on 401s
      // (auth/id-token-expired, auth/user-token-expired, ...). Appending it
      // makes the browser console show WHY a token was rejected instead of
      // a generic message.
      if (typeof data?.code === "string") message += ` [${data.code}]`;
    } catch {
      // ignore body parse failures
    }
    throw new ApiError(message, res.status);
  }

  return res.json() as Promise<T>;
}
