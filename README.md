# ClipForge 🔥

Turn long-form videos (podcasts, YouTube videos, webinars) into short, viral-ready vertical clips with animated word-by-word captions — automatically. An Opus Clip–style SaaS built end-to-end.

**Brand color:** `#FF5D1C` — used for CTAs, virality-score gradients, active nav states, and the caption word-highlight in every rendered clip.

---

## Architecture

```
┌────────────────────┐     ┌─────────────────────┐     ┌──────────────────────┐
│ frontend (Next.js) │────▶│ backend (Express)   │────▶│ Redis + BullMQ       │
│ landing + dashboard│     │ auth'd API routes   │     │ clipforge-pipeline   │
│ Supabase Auth SSR  │     │ Shotstack webhook   │     │ clipforge-publishing │
└─────────┬──────────┘     │ social OAuth flows  │     └──────────┬───────────┘
          │                └─────────────────────┘                │
          │ Realtime (projects/clips/jobs/scheduled_posts)        ▼
┌─────────▼──────────────────────────────────────────┐   ┌──────────────────────┐
│ Supabase (Postgres + Auth + Storage)               │   │ worker (BullMQ)      │
│ profiles · projects · clips · jobs ·               │   │ FFmpeg trim/thumb    │
│ scheduled_posts · social_connections               │   │ Google STT           │
│ buckets: source-videos · clips · assets            │   │ Kimi analysis        │
└────────────────────────────────────────────────────┘   │ Shotstack render     │
                                                         │ scheduled publishing │
                                                         └──────────────────────┘
```

### Pipeline (per project)

1. **download** — RapidAPI downloader fetches the source URL → stored in the `source-videos` bucket (uploads skip this stage)
2. **transcribe** — FFmpeg extracts mono 16 kHz WAV → Google Speech-to-Text (`enableWordTimeOffsets`) → word-level transcript saved as JSONB + credits deducted
3. **analyze** — Kimi (Moonshot AI) returns strict JSON clip suggestions `{start, end, title, hook, virality_score, reason, hashtags}` → one `clips` row per suggestion
4. **render** (per clip) — FFmpeg trims the segment + thumbnail → raw clip/SRT uploaded to Storage → Shotstack Edit JSON (1080×1920 `fit: crop`, caption track with `#FF5D1C` word highlight) → submitted with a webhook callback (`SHOTSTACK_WEBHOOK_URL` is required — the worker never polls)
5. **finalize** — Shotstack calls the backend's secret-verified webhook → finished MP4 is re-uploaded from Shotstack's CDN into the `clips` bucket for permanent ownership → clip `status=ready`

Scheduling: "Schedule" creates a `scheduled_posts` row + a delayed BullMQ job; when it fires the worker uploads the clip via YouTube Data API / Meta Graph API / TikTok Content Posting API and marks the post `published` or `failed`.

---

## Repository layout

| Path | Service | Railway start command |
|---|---|---|
| `frontend/` | Next.js 14 (App Router) + Tailwind + shadcn/ui + Framer Motion | `npm run start` (after `npm run build`) |
| `backend/` | Express API — job creation, Shotstack webhook, social OAuth | `npm run start` |
| `worker/` | BullMQ consumer — FFmpeg, STT, Kimi, Shotstack, publishing | `npm run start` |
| `supabase/` | SQL migration + setup guide | run once in SQL Editor |

---

## Local setup

### 1. Supabase

1. Create a project → **SQL Editor** → run [`supabase/migrations/0001_init.sql`](supabase/migrations/0001_init.sql)
   (tables, profile trigger, RLS, storage buckets, realtime)
2. Enable **Email** and **Google** providers (see [`supabase/README.md`](supabase/README.md))
3. Site URL `http://localhost:3000`, redirect URL `http://localhost:3000/auth/callback`

### 2. Frontend

```bash
cd frontend
cp .env.local.example .env.local   # fill in Supabase URL + anon key
npm run dev                        # http://localhost:3000
```

### 3. Backend

```bash
cd backend
cp .env.example .env               # Supabase service key, Redis, OAuth creds…
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
cp .env.example .env               # Supabase service key, Redis, API keys…
npm run start
```

Requires a local **Redis** (`docker run -p 6379:6379 redis:7`) and **FFmpeg** (bundled automatically via `ffmpeg-static`).

> The worker degrades gracefully: without `KIMI_API_KEY` it falls back to evenly spaced sample clips so the trim → render → storage path stays testable. Everything else fails loudly with the reason in the `jobs` table.

### 5. API keys (all optional per feature)

| Feature | Keys |
|---|---|
| URL download | RapidAPI key + downloader endpoint (`RAPIDAPI_KEY`, `RAPIDAPI_HOST`, `RAPIDAPI_DOWNLOADER_URL`) |
| Transcription | Google Cloud service-account JSON (`GOOGLE_APPLICATION_CREDENTIALS` path or `GOOGLE_CREDENTIALS_JSON` inline) |
| AI clip detection | Kimi / Moonshot (`KIMI_API_KEY`, optional `KIMI_API_BASE_URL`, `KIMI_MODEL`) |
| Rendering | Shotstack (`SHOTSTACK_API_KEY`, `SHOTSTACK_ENV=stage\|v1`) |
| Publishing | `YOUTUBE_CLIENT_ID/SECRET`, `META_APP_ID/SECRET` (IG + FB), `TIKTOK_CLIENT_KEY/SECRET` |

---

## Railway deployment

Create four services from this repo (monorepo root), each with its **Root Directory** set:

| Service | Root directory | Start command | Notes |
|---|---|---|---|
| `clipforge-web` | `frontend` | `npx next start` | Build command `npx next build` |
| `clipforge-api` | `backend` | `npm start` | Needs a public domain (OAuth callbacks + Shotstack webhook) |
| `clipforge-worker` | `worker` | `npm start` | Dockerfile included (Alpine + build tools for gRPC) |
| Redis | — | — | Railway Redis plugin / template → set `REDIS_URL` on api + worker |

Set the env vars from each service's `.env.example`, plus cross-links:

- `frontend`: `NEXT_PUBLIC_API_URL=https://<clipforge-api-domain>`
- `backend`: `BACKEND_URL=https://<clipforge-api-domain>`, `FRONTEND_URL=https://<clipforge-web-domain>`
- Social OAuth redirect URIs (in Meta / Google Cloud / TikTok developer consoles):
  `https://<clipforge-api-domain>/api/social/<platform>/callback`
- Shotstack webhook (**required** for render completion): worker env `SHOTSTACK_WEBHOOK_URL`
  = `https://<clipforge-api-domain>/webhooks/shotstack`, with `SHOTSTACK_WEBHOOK_SECRET`
  matching the backend's value
- Shotstack webhook (dashboard, optional belt-and-suspenders): `https://<clipforge-api-domain>/webhooks/shotstack`

`ENCRYPTION_KEY` must be **identical** on backend and worker (tokens are encrypted by the backend, decrypted by the worker).

---

## Feature checklist (spec → implementation)

1. ✅ Landing page — hero, trust bar, how-it-works, bento features, before/after demo, pricing (monthly/annual), testimonials, FAQ accordion, final CTA, footer — responsive, light/dark
2. ✅ Supabase Auth — email/password + Google OAuth, `/login` `/signup`, `/auth/callback`, middleware-protected `/dashboard/*`, profile trigger
3. ✅ Theme toggle — next-themes, persisted, navbar + footer + dashboard
4. ✅ Project creation — paste URL or file upload (drag & drop → Supabase Storage)
5. ✅ Async pipeline — download → transcribe → analyze → render → finalize, live status via Supabase Realtime (pipeline tracker with per-stage states)
6. ✅ Clip gallery — 9:16 preview player, virality-score badge, hashtags, download, regenerate captions (3 style presets, brand-orange highlight)
7. ✅ Social connections — OAuth connect/disconnect for YouTube, Instagram, TikTok, Facebook; AES-256-GCM encrypted tokens
8. ✅ Schedule modal + calendar month view — reschedule/cancel, status pills (`scheduled` in brand orange)
9. ✅ Delayed BullMQ publish jobs — YouTube Shorts (resumable upload), IG Reels (container flow), FB Reels, TikTok (PULL_FROM_URL); token refresh
10. ✅ Credit system — `credits_remaining`, 1 credit per started minute, gate on project creation
11. ✅ Caption customization — Classic / Karaoke / Bold Pop presets, Shotstack caption styles with `#FF5D1C` highlight default
