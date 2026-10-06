# ClipForge on Modal — setup

Modal is the watermark-free, free-tier cloud render provider. It runs **this
repo's own ffmpeg renderer** (`worker/src/lib/localRender.js`) inside a Modal
container, so clips come out byte-for-byte identical to `RENDER_PROVIDER=local`
(captions with word-sync, b-roll, 9:16 zoom/contain layouts, watermark, music
bed) — but without needing encode capacity on the worker box.

Modal's Starter plan includes **$30/month of compute** (~600 core-hours at
$0.0000131/core-second). One 60 s 1080x1920 clip at 4 vCPU costs roughly
**$0.004**, i.e. thousands of clips per month inside the free credit.

---

## 1. Install the Modal client (once)

```powershell
pip install --upgrade modal
# or: uv tool install modal
```

## 2. Sign in (opens a browser)

```powershell
modal setup
```

Creates an API token in `%USERPROFILE%\.modal.toml`. `modal token new` does the
same thing if `setup` ever misbehaves.

## 3. Create the shared secret (once)

Both sides authenticate with the same random string. Generate one and register
it with Modal:

```powershell
# pick any long random string, e.g.
$secret = -join ((1..48) | ForEach-Object { '{0:x}' -f (Get-Random -Max 16) })
modal secret create clipforge-render MODAL_RENDER_SECRET=$secret
$secret   # keep this value for step 5
```

## 4. Deploy the app (from the repo root)

```powershell
cd "C:\Users\tarat\Desktop\Official Clipforge V1.0"
modal deploy modal/modal_render.py
```

The first build installs Node 20, npm, FastAPI and
`ffmpeg-static` (~2-4 min). Re-deploys reuse the cache and take seconds. The
command prints the web endpoints; note the one ending in `-web.modal.run`:

```
https://<workspace>--clipforge-render-web.modal.run
```

Smoke-test it (should print `{"ok":true,"service":"clipforge-render"}`):

```powershell
curl.exe "https://<workspace>--clipforge-render-web.modal.run/health"
```

> If the build fails on the base image, replace the `modal.Image.from_registry(...)`
> line in `modal_render.py` with
> `modal.Image.debian_slim(python_version="3.13").apt_install("nodejs", "npm", "ca-certificates")`.

## 5. Point the worker at it

In `worker/.env` (and in your production worker's environment):

```ini
RENDER_PROVIDER=modal
MODAL_RENDER_URL=https://<workspace>--clipforge-render-web.modal.run
MODAL_RENDER_SECRET=<the value from step 3>

# Unchanged, but required: renders complete via this webhook.
RENDER_WEBHOOK_URL=https://<your-backend>/webhooks/render
RENDER_WEBHOOK_SECRET=<already set>
```

`C:\Users\tarat\Desktop\Official Clipforge V1.0\worker\.env.example` documents
the same block. Restart the worker, then watch the log line:

```
[render <clipId>] modal render modal-<uuid> submitted
```

## 6. Re-render a clip to verify

Click **Save & re-render** on any clip (or hit `POST /api/clips/:id/regenerate`).
The flow is:

```
worker → POST /submit           (returns instantly; Modal spawns a container)
Modal  → ffmpeg (localRender.js) → /data/renders/<id>.mp4
Modal  → POST <RENDER_WEBHOOK_URL>  { id, status:"done", url:".../download/<id>" }
backend→ enqueue finalize → worker GET /download/<id> → R2 + thumbnail + Stream
```

The worker's watchdog also polls `GET /status/<id>` every minute, so a dropped
webhook still finishes the clip.

---

## Operating notes

| Thing | Where |
|---|---|
| Render logs | `modal app logs clipforge-render` |
| Rendered files | Volume `clipforge-renders` (auto-pruned after 3 days) |
| Render status | Dict `clipforge-render-status` |
| Change CPU/RAM | `RENDER_CPU` / `RENDER_MEMORY_MB` in `modal_render.py` |
| Cap parallelism | `MAX_CONTAINERS` (default 4) |
| Free-credit safety net | Modal dashboard → Usage → set a Budget |

Renders are deleted 3 days after they land, and the worker downloads its copy
during `finalize` (which is what actually becomes the user's clip in R2), so
the Volume stays small.

## Troubleshooting

- **401 from `/submit`** — `MODAL_RENDER_SECRET` in `worker/.env` differs from
  the Modal secret. Re-run
  `modal secret create clipforge-render MODAL_RENDER_SECRET=<value>` and
  re-deploy.
- **Renders stuck at `rendering`** — check `modal app logs clipforge-render`;
  the ffmpeg stderr tail is recorded in the status Dict and shown to the user
  as the clip's error message.
- **`ffmpeg-static` download failed during build** — rebuild with
  `MODAL_IGNORE_CACHE=1 modal deploy modal/modal_render.py` (the binary is
  fetched from GitHub releases at image-build time).
- **Nothing renders / `MODAL_RENDER_URL is not configured`** — the worker env
  var is missing or has a trailing slash plus path; use the bare
  `https://<workspace>--clipforge-render-web.modal.run` value.
