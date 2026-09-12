# ClipForge 🔥

Turn long-form videos (podcasts, YouTube videos, webinars) into short, viral-ready vertical clips with animated word-by-word captions — automatically. An Opus Clip–style SaaS built end-to-end.

**Brand color:** `#FF5D1C` — used for CTAs, virality-score gradients, active nav states, and the caption word-highlight in every rendered clip.

---

## Architecture

```
┌────────────────────┐     ┌─────────────────────┐     ┌──────────────────────┐
│ frontend (Next.js) │────▶│ backend (Express)   │────▶│ Redis + BullMQ       │
│ landing + dashboard│     │ auth'd API routes   │     │ clipforge-pipeline   │
│ Firebase Auth      │     │ Shotstack webhook   │     │ clipforge-publishing │
└─────────┬──────────┘     │ social OAuth flows  │     └──────────┬───────────┘
          │                └─────────────────────┘                │
          │ Firestore live listeners (projects/clips/jobs/…)      ▼
┌─────────▼──────────────────────────────────────────┐   ┌──────────────────────┐
│ Firebase (Auth + Firestore)                        │   │ worker (BullMQ)      │
│ profiles · projects · clips · jobs ·               │   │ FFmpeg trim/thumb    │
│ scheduled_posts · social_connections               │   │ Google STT           │
│ Cloudflare R2 (file storage)                       │   │ z.ai GLM analysis    │
└────────────────────────────────────────────────────┘   │ Shotstack render     │
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
2. **transcribe** — FFmpeg extracts mono 16 kHz WAV → Google Speech-to-Text (`enableWordTimeOffsets`) → word-level transcript saved + credits deducted
3. **analyze** — z.ai (Zhipu GLM, OpenAI-compatible API) returns strict JSON clip suggestions `{start, end, title, hook, virality_score, reason, hashtags}` → one `clips` doc per suggestion
4. **render** (per clip) — FFmpeg trims the segment + thumbnail → raw clip/SRT uploaded to R2 → Shotstack Edit JSON (1080×1920 `fit: crop`, caption track with `#FF5D1C` word highlight) → submitted with a webhook callback (`SHOTSTACK_WEBHOOK_URL` is required — the worker never polls)
5. **finalize** — Shotstack calls the backend's secret-verified webhook → finished MP4 is re-uploaded from Shotstack's CDN into R2 for permanent ownership → clip `status=ready`

Scheduling: "Schedule" creates a `scheduled_posts` doc + a delayed BullMQ job; when it fires the worker uploads the clip via YouTube Data API / Meta Graph API / TikTok Content Posting API and marks the post `published` or `failed`.

---

## Repository layout

| Path | Service | Start command |
|---|---|---|
| `frontend/` | Next.js 14 (App Router) + Tailwind + shadcn/ui + Framer Motion | `npm run start` (after `npm run build`) |
| `backend/` | Express API — job creation, Shotstack webhook, social OAuth | `npm run start` |
| `worker/` | BullMQ consumer — FFmpeg, STT, z.ai GLM, Shotstack, publishing | `npm run start` |
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
| Rendering | Shotstack (`SHOTSTACK_API_KEY`, `SHOTSTACK_ENV=stage\|v1`) |
| Publishing | `YOUTUBE_CLIENT_ID/SECRET`, `META_APP_ID/SECRET` (IG + FB), `TIKTOK_CLIENT_KEY/SECRET` |

---

## Northflank deployment

Create the services in the `official-clipforge` Northflank project from this repo, each with its **build root directory** set (all three have Dockerfiles — Northflank builds them automatically):

| Service | Root directory | Notes |
|---|---|---|
| `clipforge-web` | `frontend` | Build args = the `NEXT_PUBLIC_*` vars (inlined at build time) |
| `clipforge-api` | `backend` | Single image hosts API + worker + bundled redis; needs a public port for 4000 (OAuth callbacks + Shotstack webhook) |
| Redis addon | — | Northflank Redis addon (or Upstash) → set `REDIS_URL` on the api service |

Environment variables: create a **Secret Group** in the project with the vars from each `.env.example`, link it to the services, plus cross-links:

- `frontend` build args: `NEXT_PUBLIC_API_URL=https://<clipforge-api-domain>`, `NEXT_PUBLIC_FIREBASE_*`, `NEXT_PUBLIC_R2_PUBLIC_BASE_URL`
- `backend`: `BACKEND_URL=https://<clipforge-api-domain>`, `FRONTEND_URL=https://<clipforge-web-domain>`, `FIREBASE_PROJECT_ID`, `FIREBASE_SERVICE_ACCOUNT`, `REDIS_URL`
- Social OAuth redirect URIs (in Meta / Google Cloud / TikTok developer consoles):
  `https://<clipforge-api-domain>/api/social/<platform>/callback`
- Firebase Auth → Settings → Authorized domains: add the `clipforge-web` domain
- Shotstack webhook (**required** for render completion): worker env `SHOTSTACK_WEBHOOK_URL`
  = `https://<clipforge-api-domain>/webhooks/shotstack`, with `SHOTSTACK_WEBHOOK_SECRET`
  matching the backend's value

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
11. ✅ Caption customization — Classic / Karaoke / Bold Pop presets, Shotstack caption styles with `#FF5D1C` highlight default
