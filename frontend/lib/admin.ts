/**
 * Admin allowlist — must mirror the backend's ADMIN_EMAILS (backend/src/config/env.js),
 * which is the actual enforcement point. This only controls UI visibility.
 */
export const ADMIN_EMAILS = (
  process.env.NEXT_PUBLIC_ADMIN_EMAILS ??
  "pencilmacro@gmail.com,taratip.pae@gmail.com"
)
  .split(",")
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean);

export function isAdminEmail(email: string | null | undefined): boolean {
  return Boolean(email && ADMIN_EMAILS.includes(email.toLowerCase()));
}
