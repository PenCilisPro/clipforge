import "dotenv/config";

export const env = {
  supabaseUrl: process.env.SUPABASE_URL,
  supabaseServiceKey: process.env.SUPABASE_SERVICE_KEY,
  redisUrl: process.env.REDIS_URL ?? "redis://127.0.0.1:6379",
  concurrency: Number(process.env.WORKER_CONCURRENCY ?? 2),
  maxClips: Number(process.env.MAX_CLIPS_PER_VIDEO ?? 6),
  sttLanguage: process.env.STT_LANGUAGE_CODE ?? "en-US",

  rapidapiKey: process.env.RAPIDAPI_KEY,
  rapidapiHost: process.env.RAPIDAPI_HOST,
  rapidapiDownloaderUrl: process.env.RAPIDAPI_DOWNLOADER_URL,

  googleCredentialsPath: process.env.GOOGLE_APPLICATION_CREDENTIALS,
  googleCredentialsJson: process.env.GOOGLE_CREDENTIALS_JSON,

  kimiApiKey: process.env.KIMI_API_KEY,
  kimiBaseUrl: process.env.KIMI_API_BASE_URL ?? "https://api.moonshot.cn/v1",
  kimiModel: process.env.KIMI_MODEL ?? "moonshot-v1-32k",

  shotstackApiKey: process.env.SHOTSTACK_API_KEY,
  shotstackEnv: process.env.SHOTSTACK_ENV ?? "stage",
  // Required: renders complete via the Shotstack webhook → backend
  // /webhooks/shotstack → finalize stage. Without it renders can't finish.
  shotstackWebhookUrl: process.env.SHOTSTACK_WEBHOOK_URL,
  shotstackWebhookSecret: process.env.SHOTSTACK_WEBHOOK_SECRET,
  encryptionKey: process.env.ENCRYPTION_KEY,
};

export function warnMissing() {
  const checks = {
    SUPABASE_URL: env.supabaseUrl,
    SUPABASE_SERVICE_KEY: env.supabaseServiceKey,
    REDIS_URL: process.env.REDIS_URL,
  };
  for (const [name, value] of Object.entries(checks)) {
    if (!value) console.warn(`[worker] ${name} is not set — worker cannot run.`);
  }
  // [env var names], consequence when all of them are unset
  const optionalWarnings = [
    { names: ["RAPIDAPI_KEY"], consequence: "URL projects cannot be downloaded" },
    {
      names: ["GOOGLE_APPLICATION_CREDENTIALS", "GOOGLE_CREDENTIALS_JSON"],
      consequence: "transcription will fail",
    },
    { names: ["KIMI_API_KEY"], consequence: "AI analysis falls back to sample clips" },
    { names: ["SHOTSTACK_API_KEY"], consequence: "rendering will fail" },
    {
      names: ["SHOTSTACK_WEBHOOK_URL"],
      consequence: "renders will submit but never complete (webhook-only design)",
    },
    { names: ["ENCRYPTION_KEY"], consequence: "social publishing will fail" },
  ];
  for (const { names, consequence } of optionalWarnings) {
    const missing = names.every((n) => !process.env[n]);
    if (missing) console.warn(`[worker] ${names.join("|")} not set → ${consequence}.`);
  }
}
