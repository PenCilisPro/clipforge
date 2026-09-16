import { createClient } from "@/lib/supabase/client";

export const API_URL =
  process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

/**
 * Fetch the Express backend with the caller's Firebase ID token attached.
 * getIdToken() refreshes automatically, so no manual refresh dance is needed.
 *
 * Network-level failures (fetch rejects with TypeError, e.g. the backend
 * briefly restarting on Northflank) are retried with backoff on idempotent
 * requests so a transient blip doesn't surface as a hard error in the UI.
 */
export async function apiFetch<T = unknown>(
  path: string,
  options: { method?: string; body?: unknown } = {}
): Promise<T> {
  const supabase = createClient();
  const session = (await supabase.auth.getSession()).data.session;
  if (!session) throw new Error("Not signed in");

  const method = options.method ?? "GET";
  const isIdempotent = method === "GET" || method === "HEAD";
  const maxAttempts = isIdempotent ? 3 : 1;

  let res!: Response;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      res = await fetch(`${API_URL}${path}`, {
        method,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
        },
        body: options.body ? JSON.stringify(options.body) : undefined,
      });
      break;
    } catch (err) {
      // Only genuine transport failures throw here; HTTP error statuses
      // don't. Retrying won't help a dead connection pattern, but a
      // single missed response during a backend restart resolves itself.
      if (attempt === maxAttempts) throw err;
      await new Promise((r) => setTimeout(r, 500 * attempt * attempt));
    }
  }

  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    try {
      const data = await res.json();
      if (data?.error) message = data.error;
    } catch {
      // ignore body parse failures
    }
    throw new Error(message);
  }

  return res.json() as Promise<T>;
}
