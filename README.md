# ClipForge 🔥

Turn long-form videos (podcasts, YouTube videos, webinars) into short, viral-ready vertical clips with animated word-by-word captions — automatically. An Opus Clip–style SaaS built end-to-end.

**Brand color:** `#FF5D1C` — used for CTAs, virality-score gradients, active nav states, and the caption word-highlight in every rendered clip.

---

## Architecture

```
┌────────────────────┐     ┌─────────────────────┐     ┌──────────────────────┐
│ frontend (Next.js) │────▶│ backend (Express)   │────▶│ Redis + BullMQ       │
│ landing + dashboard│     │ auth'd API routes   │     │ clipforge-pipeline   │
│ Firebase Auth      │     │ render webhook      │     │ clipforge-publishing │
└─────────┬──────────┘     │ social OAuth flows  │     └──────────┬───────────┘
          │                └─────────────────────┘                │
          │ Firestore live listeners (projects/clips/jobs/…)      ▼
┌─────────▼──────────────────────────────────────────┐   ┌──────────────────────┐
│ Firebase (Auth + Firestore)                        │   │ worker (BullMQ)      │
│ profiles · projects · clips · jobs ·               │   │ FFmpeg trim/thumb    │
│ scheduled_posts · social_connections               │   │ Google STT           │
│ Cloudflare R2 (file storage)                       │   │ z.ai GLM analysis    │
└────────────────────────────────────────────────────┘   │ Creatomate render    │
                                                         │ scheduled publishing │
                                                         └──────────────────────┘
```

Both `backend/` and `worker/` talk to Firestore through a drop-in supabase-js
compatibility layer (`src/lib/firestore.js` in each) so query call sites read
exactly as before. The frontend uses a matching browser shim
(`frontend/lib/supabase/client.ts`) over the Firebase JS SDK, with Firestore
security rules ([`firestore.rules`](firestore.rules)) replacing RLS.

### Pipeline (per project)

1. **download** — RapidAPI downloader fetches the source URL → stored in the R2 `source-videos/` prefix (uploads skip this stage)
2. **transcribe** — FFmpeg extracts the audio in a single pass as raw mono 16 kHz PCM → fixed 55-second byte slices go to Google Speech-to-Text (enableWordTimeOffsets) one at a time → word-level transcript saved + credits deducted
3. **analyze** — z.ai (Zhipu GLM, OpenAI-compatible API) returns strict JSON clip suggestions `{start, end, title, hook, virality_score, reason, hashtags}` → one `clips` doc per suggestion
4. **render** (per clip) — the worker gives the render provider (Creatomate by default; watermark-free on every plan) a signed R2 source URL and trim offset; the provider cuts and renders the 1080×1920 clip in its cloud with the caption track. No full source download, local video re-encode, or temporary raw clip upload is needed for each clip. Completion uses the required webhook (RENDER_WEBHOOK_URL).
5. **finalize** — the backend verifies the render callback; the worker streams the finished MP4 from the provider's CDN into R2 and creates its poster from the final output. The MP4 is optionally mirrored to Cloudflare Stream for playback.

Large uploads go directly from the browser to R2 as an S3 multipart upload (64 MB parts, presigned by the API and assembled natively inside R2), so no source-sized bytes ever pass through the API/worker service and the worker never reassembles or re-uploads the file. Uploads are capped at 1 GB (checked client-side and enforced on project creation). The R2 bucket's CORS config must expose the ETag header (`ExposeHeaders: ["ETag"]`) so the browser can read part ETags for `CompleteMultipartUpload` — without it the site silently falls back to the legacy 40 MB parts + manifest flow, which the worker still supports. The worker uses one pipeline job at a time, a single-pass single-threaded FFmpeg audio extraction (chunked STT slices are read from the PCM file by byte offset — ffmpeg never re-opens the source per chunk), and 128 MB Node heap caps for each Node process. This targets a 0.2 vCPU / 512 MB combined API/worker service, with lower throughput and longer queues at that CPU allocation. Transcription needs temporary disk space roughly the size of the source file plus ~115 MB per hour of audio. Transcribe jobs get their own ceiling via `TRANSCRIBE_TIMEOUT_MS` (default 120 min) so long sources are not killed and retried at the 40-min default. Rendering happens remotely from the source's signed R2 URL, so the 1 GB upload cap is independent of any local render limits.

Scheduling: "Schedule" creates a `scheduled_posts` doc + a delayed BullMQ job; when it fires the worker uploads the clip via YouTube Data API / Meta Graph API / TikTok Content Posting API and marks the post `published` or `failed`.

---

## Repository layout

| Path | Service | Start command |
|---|---|---|
| `frontend/` | Next.js 14 (App Router) + Tailwind + shadcn/ui + Framer Motion | `npm run start` (after `npm run build`) |
| `backend/` | Express API — job creation, render webhook, social OAuth | `npm run start` |
| `worker/` | BullMQ consumer — FFmpeg, STT, z.ai GLM, Creatomate render, publishing | `npm run start` |
| `firestore.rules` / `firestore.indexes.json` | Firestore security rules + composite indexes | deploy once |
| `backend/scripts/migrate-supabase-to-firestore.mjs` | one-shot data migration from the old Supabase project | run once |

---

## Local setup

### 1. Firebase

1. Firebase console → **Authentication** → enable **Email/Password** and **Google** providers
2. **Firestore Database** → create database (production mode) → paste
   [`firestore.rules`](firestore.rules) into the Rules tab. Deploy
   [`firestore.indexes.json`](firestore.indexes.json) with `firebase deploy --only firestore:indexes`
   (or click the index-creation links the console shows on first query).
3. **Project settings → Service accounts → Generate new private key** → the JSON
   is your `FIREBASE_SERVICE_ACCOUNT` value (backend + worker)
4. **Project settings → General → Your apps → Web app** → copy the config values
   into the frontend's `NEXT_PUBLIC_FIREBASE_*` variables
5. Add `http://localhost:3000` (and your production domain) to
   **Authentication → Settings → Authorized domains**

### 2. Frontend

```bash
cd frontend
cp .env.local.example .env.local   # fill in Firebase web config + API URL
npm run dev                        # http://localhost:3000
```

### 3. Backend

```bash
cd backend
cp .env.example .env               # Firebase service account, Redis, OAuth creds…
npm run dev                        # http://localhost:4000
```

Generate the two secrets it needs:

```bash
node -e "console.log('APP_SECRET='+require('crypto').randomBytes(32).toString('hex'))"
node -e "console.log('ENCRYPTION_KEY='+require('crypto').randomBytes(32).toString('hex'))"
```

### 4. Worker

```bash
cd worker
cp .env.example .env               # Firebase service account, Redis, API keys…
npm run start
```

Requires a local **Redis** (`docker run -p 6379:6379 redis:7`) and **FFmpeg** (bundled automatically via `ffmpeg-static`).

> The worker degrades gracefully: without `ZAI_API_KEY` (or when the AI provider errors) it falls back to evenly spaced sample clips so the trim → render → storage path stays testable. Everything else fails loudly with the reason in the `jobs` collection.

### 5. API keys (all optional per feature)

| Feature | Keys |
|---|---|
| URL download | RapidAPI key + downloader endpoint (`RAPIDAPI_KEY`, `RAPIDAPI_HOST`, `RAPIDAPI_DOWNLOADER_URL`) |
| Transcription | Google Cloud service-account JSON (`GOOGLE_APPLICATION_CREDENTIALS` path or `GOOGLE_CREDENTIALS_JSON` inline) |
| AI clip detection | z.ai / Zhipu GLM (`ZAI_API_KEY`, optional `ZAI_API_BASE_URL`, `ZAI_MODEL`; default model `glm-4.5-flash` — free tier) |
| Rendering | Creatomate (`CREATOMATE_API_KEY`; optional `RENDER_PROVIDER=creatomate\|shotstack`) — watermark-free on every plan |
| Publishing | `YOUTUBE_CLIENT_ID/SECRET`, `META_APP_ID/SECRET` (IG + FB), `TIKTOK_CLIENT_KEY/SECRET` |

---

## Northflank deployment

Create the services in the `official-clipforge` Northflank project from this repo, each with its **build root directory** set (all three have Dockerfiles — Northflank builds them automatically):

| Service | Root directory | Notes |
|---|---|---|
| `clipforge-web` | `frontend` | Build args = the `NEXT_PUBLIC_*` vars (inlined at build time) |
| `clipforge-api` | `backend` | Combined API + worker + bundled Redis; public port 4000 for OAuth callbacks and render webhooks. Set the service to 0.2 vCPU / 512 MB RAM and keep one replica for the constrained profile.
| Redis addon | — | Northflank Redis addon (or Upstash) → set `REDIS_URL` on the api service |

Environment variables: create a **Secret Group** in the project with the vars from each `.env.example`, link it to the services, plus cross-links:

- `frontend` build args: `NEXT_PUBLIC_API_URL=https://<clipforge-api-domain>`, `NEXT_PUBLIC_FIREBASE_*`, `NEXT_PUBLIC_R2_PUBLIC_BASE_URL`
- `backend`: `BACKEND_URL=https://<clipforge-api-domain>`, `FRONTEND_URL=https://<clipforge-web-domain>`, `FIREBASE_PROJECT_ID`, `FIREBASE_SERVICE_ACCOUNT`, `REDIS_URL`
- Social OAuth redirect URIs (in Meta / Google Cloud / TikTok developer consoles):
  `https://<clipforge-api-domain>/api/social/<platform>/callback`
- Firebase Auth → Settings → Authorized domains: add the `clipforge-web` domain
- Cloudflare Stream (optional, clip playback delivery): worker + backend envs `CLOUDFLARE_ACCOUNT_ID` (or reuse `R2_ACCOUNT_ID`), `CLOUDFLARE_STREAM_API_TOKEN` (API token with Stream:Edit). Optional signed playback: `CLOUDFLARE_STREAM_SIGNING_KEY` + `CLOUDFLARE_STREAM_SIGNING_TOKEN` (Stream → Settings → Signed URLs) on both services — when unset, mirrored clips use unguessable-UID unsigned playback URLs
- Render webhook (**required** for render completion): worker env `RENDER_WEBHOOK_URL`
  = `https://<clipforge-api-domain>/webhooks/render`, with `RENDER_WEBHOOK_SECRET`
  matching the backend's value (the legacy `SHOTSTACK_WEBHOOK_URL`/`SHOTSTACK_WEBHOOK_SECRET`
  names are still accepted)

`ENCRYPTION_KEY` must be **identical** on backend and worker (tokens are encrypted by the backend, decrypted by the worker).

### Migrating existing data

While the old Supabase project still exists:

```bash
cd backend
SUPABASE_URL=https://<ref>.supabase.co \
SUPABASE_SERVICE_ROLE_KEY=<service-role-key> \
FIREBASE_SERVICE_ACCOUNT="$(cat service-account.json)" \
node scripts/migrate-supabase-to-firestore.mjs
```

Auth users carry over **with their passwords** (bcrypt hashes are imported),
row uuids are reused as Firebase uids so every foreign key stays valid.

---

## Feature checklist (spec → implementation)

1. ✅ Landing page — hero, trust bar, how-it-works, bento features, before/after demo, pricing (monthly/annual), testimonials, FAQ accordion, final CTA, footer — responsive, light/dark
2. ✅ Firebase Auth — email/password + Google sign-in popup, `/login` `/signup`, client-guarded `/dashboard/*`, auto-created profile docs, admin custom claims
3. ✅ Theme toggle — next-themes, persisted, navbar + footer + dashboard
4. ✅ Project creation — paste URL or file upload (drag & drop → Cloudflare R2)
5. ✅ Async pipeline — download → transcribe → analyze → render → finalize, live status via Firestore listeners (pipeline tracker with per-stage states)
6. ✅ Clip gallery — 9:16 preview player, virality-score badge, hashtags, download, regenerate captions (3 style presets, brand-orange highlight)
7. ✅ Social connections — OAuth connect/disconnect for YouTube, Instagram, TikTok, Facebook; AES-256-GCM encrypted tokens
8. ✅ Schedule modal + calendar month view — reschedule/cancel, status pills (`scheduled` in brand orange)
9. ✅ Delayed BullMQ publish jobs — YouTube Shorts (resumable upload), IG Reels (container flow), FB Reels, TikTok (PULL_FROM_URL); token refresh
10. ✅ Credit system — `credits_remaining`, 1 credit per started minute, gate on project creation (Firestore transaction replaces the old SQL function)
11. ✅ Caption customization — Classic / Karaoke / Bold Pop presets, cloud-rendered caption styles with `#FF5D1C` highlight default
