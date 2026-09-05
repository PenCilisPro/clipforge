import "dotenv/config";

function required(name, fallback = undefined) {
  const value = process.env[name] ?? fallback;
  if (!value) {
    // Don't crash the process for optional integrations — log loudly instead.
    console.warn(`[env] Missing ${name} — related features will be disabled.`);
    return undefined;
  }
  return value;
}

export const env = {
  port: Number(process.env.PORT ?? 4000),
  backendUrl: required("BACKEND_URL", "http://localhost:4000"),
  frontendUrl: required("FRONTEND_URL", "http://localhost:3000"),

  supabaseUrl: required("SUPABASE_URL"),
  supabaseServiceKey: required("SUPABASE_SERVICE_KEY"),

  redisUrl: required("REDIS_URL", "redis://127.0.0.1:6379"),
  appSecret: required("APP_SECRET", "dev-insecure-secret"),
  shotstackWebhookSecret: required("SHOTSTACK_WEBHOOK_SECRET", "dev-insecure-hook"),
  encryptionKey: process.env.ENCRYPTION_KEY ?? "",

  // Admin allowlist (comma-separated). These emails can access /api/admin/*.
  adminEmails: (process.env.ADMIN_EMAILS ?? "pencilmacro@gmail.com,taratip.pae@gmail.com")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean),

  metaAppId: process.env.META_APP_ID,
  metaAppSecret: process.env.META_APP_SECRET,
  youtubeClientId: process.env.YOUTUBE_CLIENT_ID,
  youtubeClientSecret: process.env.YOUTUBE_CLIENT_SECRET,
  tiktokClientKey: process.env.TIKTOK_CLIENT_KEY,
  tiktokClientSecret: process.env.TIKTOK_CLIENT_SECRET,

  // Jamendo music catalog (background music picker)
  jamendoClientId: process.env.JAMENDO_CLIENT_ID,

  // AI enhancements from the clip editor (b-roll + music picking), mirroring
  // the worker's integrations.
  zaiApiKey: process.env.ZAI_API_KEY,
  zaiBaseUrl: process.env.ZAI_API_BASE_URL ?? "https://api.z.ai/api/paas/v4",
  zaiModel: process.env.ZAI_MODEL ?? "glm-4.5-flash",
  pexelsApiKey: process.env.PEXELS_API_KEY,
  pixabayApiKey: process.env.PIXABAY_API_KEY,
};

export function assertCriticalEnv() {
  for (const key of ["SUPABASE_URL", "SUPABASE_SERVICE_KEY", "REDIS_URL"]) {
    if (!process.env[key]) {
      console.warn(`[env] ${key} is not set — API will start in degraded mode.`);
    }
  }
}
