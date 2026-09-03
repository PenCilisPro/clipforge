import { createClient } from "@/lib/supabase/client";

export const API_URL =
  process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

/**
 * Fetch the Express backend with the caller's Supabase access token attached.
 */
export async function apiFetch<T = unknown>(
  path: string,
  options: { method?: string; body?: unknown } = {}
): Promise<T> {
  const supabase = createClient();
  let session = (await supabase.auth.getSession()).data.session;

  // Background tabs can miss supabase-js's scheduled token refresh, leaving a
  // stale access token in the cookie — the backend then 401s with
  // "Invalid or expired token". Refresh explicitly when expired or close to it.
  if (session && session.expires_at && session.expires_at * 1000 < Date.now() + 30_000) {
    const { data, error } = await supabase.auth.refreshSession();
    if (!error && data.session) session = data.session;
  }

  if (!session) throw new Error("Not signed in");

  const res = await fetch(`${API_URL}${path}`, {
    method: options.method ?? "GET",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${session.access_token}`,
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

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
