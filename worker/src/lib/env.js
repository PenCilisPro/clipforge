import "dotenv/config";

export const env = {
  // Firebase (auth + Firestore). FIREBASE_SERVICE_ACCOUNT accepts the raw
  // service-account JSON, a base64 encoding of it, or a path to the file.
  // FIREBASE_PROJECT_ID falls back to that account's project_id so the worker
  // still targets the right project when only credentials are set. Do NOT
  // fall back to GOOGLE_CREDENTIALS_JSON — that account is for Google STT
  // (clipforge-v1), a different project from Firebase (clipforge-ai-8326b).
  firebaseProjectId:
    process.env.FIREBASE_PROJECT_ID ??
    safeCredsProjectId(process.env.FIREBASE_SERVICE_ACCOUNT),
  firebaseServiceAccount: process.env.FIREBASE_SERVICE_ACCOUNT,

  // Cloudflare R2 (file storage; replaces Supabase Storage)
  r2AccountId: process.env.R2_ACCOUNT_ID,
  r2AccessKeyId: process.env.R2_ACCESS_KEY_ID,
  r2SecretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  r2Bucket: process.env.R2_BUCKET,

  // Cloudflare Stream (playback delivery; finalized clips are mirrored from
  // R2 into Stream). CLOUDFLARE_STREAM_API_TOKEN needs Stream:Edit. The
  // signing key/token pair enables signed playback URLs; when absent,
  // uploads are requireSignedURLs=false (UID URLs stay unguessable).
  cloudflareAccountId: process.env.CLOUDFLARE_ACCOUNT_ID ?? process.env.R2_ACCOUNT_ID,
  streamApiToken: process.env.CLOUDFLARE_STREAM_API_TOKEN,
  streamSigningKey: process.env.CLOUDFLARE_STREAM_SIGNING_KEY,
  streamSigningToken: process.env.CLOUDFLARE_STREAM_SIGNING_TOKEN,
  redisUrl: process.env.REDIS_URL ?? "redis://127.0.0.1:6379",
  // Keep pipeline jobs serial on the constrained service. Transcription and
  // poster extraction use FFmpeg; video clipping and final rendering happen
  // remotely in Shotstack, so concurrent FFmpeg work is unnecessary here.
  concurrency: Math.min(Number(process.env.WORKER_CONCURRENCY ?? 1), 1),
  maxClips: Number(process.env.MAX_CLIPS_PER_VIDEO ?? 6),
  sttLanguage: process.env.STT_LANGUAGE_CODE ?? "en-US",

  rapidapiKey: process.env.RAPIDAPI_KEY,
  rapidapiHost: process.env.RAPIDAPI_HOST,
  rapidapiDownloaderUrl: process.env.RAPIDAPI_DOWNLOADER_URL,

  googleCredentialsPath: process.env.GOOGLE_APPLICATION_CREDENTIALS,
  googleCredentialsJson: process.env.GOOGLE_CREDENTIALS_JSON,
  // Cloud Storage bucket for audio too big to inline in the STT request
  // (Google rejects inline requests over 10 MiB or 60s of audio).
  gcsBucket: process.env.GCS_BUCKET,

  zaiApiKey: process.env.ZAI_API_KEY,
  zaiBaseUrl: process.env.ZAI_API_BASE_URL ?? "https://api.z.ai/api/paas/v4",
  zaiModel: process.env.ZAI_MODEL ?? "glm-4.5-flash",

  // B-roll stock footage providers (either one works; Pexels preferred)
  pexelsApiKey: process.env.PEXELS_API_KEY,
  pixabayApiKey: process.env.PIXABAY_API_KEY,

  shotstackApiKey: process.env.SHOTSTACK_API_KEY,
  shotstackEnv: process.env.SHOTSTACK_ENV ?? "stage",
  // Required: renders complete via the Shotstack webhook → backend
  // /webhooks/shotstack → finalize stage. Without it renders can't finish.
  shotstackWebhookUrl: process.env.SHOTSTACK_WEBHOOK_URL,
  shotstackWebhookSecret: process.env.SHOTSTACK_WEBHOOK_SECRET,
  encryptionKey: process.env.ENCRYPTION_KEY,
};

function safeCredsProjectId(json) {
  if (!json) return undefined;
  try {
    return JSON.parse(json).project_id;
  } catch {
    try {
      return JSON.parse(Buffer.from(json, "base64").toString("utf8")).project_id;
    } catch {
      return undefined;
    }
  }
}

export function warnMissing() {
  const checks = {
    FIREBASE_PROJECT_ID: env.firebaseProjectId,
    FIREBASE_SERVICE_ACCOUNT: env.firebaseServiceAccount,
    R2_ACCOUNT_ID: env.r2AccountId,
    R2_ACCESS_KEY_ID: env.r2AccessKeyId,
    R2_SECRET_ACCESS_KEY: env.r2SecretAccessKey,
    R2_BUCKET: env.r2Bucket,
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
    {
      names: ["GCS_BUCKET"],
      consequence: "videos longer than ~5 minutes cannot be transcribed (Google STT 10 MiB inline limit)",
    },
    { names: ["ZAI_API_KEY"], consequence: "AI analysis falls back to sample clips" },
    {
      names: ["PEXELS_API_KEY", "PIXABAY_API_KEY"],
      consequence: "AI B-roll insertion is disabled (clips render talking-head only)",
    },
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
