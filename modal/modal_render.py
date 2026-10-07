"""
Modal render provider for ClipForge — watermark-free video rendering on Modal's
serverless cloud, using the worker's OWN ffmpeg renderer.

Why this exists: the worker container is too small to encode video (0.2 vCPU /
512 MB), so renders normally go to a paid cloud provider. Modal's free plan
includes $30/month of compute (~600+ core-hours), which is thousands of clips,
and it runs arbitrary containers — so instead of reimplementing the renderer we
ship `worker/src/lib/localRender.js` (captions, word-sync ASS, b-roll, 9:16
cover/contain layouts, watermark, music bed) into the image and call it.

Protocol (mirrors the Creatomate provider so the worker needs no changes):
  POST /submit              → { renderId, clipId, spec, webhookUrl } → spawns
                              the render, returns immediately
  GET  /status/{renderId}   → { status: queued|rendering|done|failed, error }
  GET  /download/{renderId} → the finished MP4 (streamed)
  on completion the render function POSTs the worker's webhookUrl with
  { id, status: "done"|"failed", url, error_message } — the same payload shape
  the backend's /webhooks/render already accepts.

Every endpoint requires the shared secret (X-Render-Secret header).

Deploy (from the repo root):
    modal secret create clipforge-render MODAL_RENDER_SECRET=<random-string>
    modal deploy modal/modal_render.py
"""

import hmac
import json
import os
import subprocess
import time
import urllib.request
from pathlib import Path

# NOTE: FastAPI is deliberately NOT imported at module level. `modal deploy`
# imports this file LOCALLY to discover the App object, and the Modal client
# does not depend on FastAPI — a top-level `import fastapi` would therefore
# require FastAPI on every machine that deploys this app. The image installs it
# for the container, and the imports happen inside `web()` where they run.
import modal

APP_NAME = "clipforge-render"
SECRET_NAME = "clipforge-render"  # must hold MODAL_RENDER_SECRET
VOLUME_NAME = "clipforge-renders"
STATUS_DICT_NAME = "clipforge-render-status"

APP_DIR = Path(__file__).resolve().parent
REPO_ROOT = APP_DIR.parent

# Scratch space inside the container (container-local disk is faster than the
# Volume for encoding); finished MP4s are moved onto the Volume afterwards.
CONTAINER_TMP = "/tmp/clipforge"
VOLUME_MOUNT = "/data"
RENDERS_DIR = f"{VOLUME_MOUNT}/renders"

# One clip is a single ffmpeg pass — 4 vCPU keeps a 60 s 1080x1920 render well
# inside the free tier while still finishing in well under a minute.
RENDER_CPU = 4.0
RENDER_MEMORY_MB = 16384  # 16 GB RAM
RENDER_TIMEOUT_S = 25 * 60
MAX_CONTAINERS = 4
# Renders are deleted after the worker has downloaded them; 3 days is generous
# headroom for a retry while keeping the Volume tiny.
RENDER_MAX_AGE_S = 3 * 24 * 3600

# node:20-bookworm-slim = the same Node runtime the worker uses, with Python
# added so Modal can serve the web endpoints from the same image.
image = (
    modal.Image.from_registry("node:20-bookworm-slim", add_python="3.13")
    .apt_install("ca-certificates", "curl")
    .pip_install("fastapi[standard]")
    .add_local_file(str(APP_DIR / "package.json"), "/app/package.json", copy=True)
    .run_commands("cd /app && npm install --omit=dev --no-fund --no-audit")
    .add_local_file(str(APP_DIR / "render-runner.mjs"), "/app/render-runner.mjs", copy=True)
    .add_local_file(
        str(REPO_ROOT / "worker/src/lib/localRender.js"), "/app/src/lib/localRender.js", copy=True
    )
    .add_local_file(
        str(REPO_ROOT / "worker/src/lib/captions.js"), "/app/src/lib/captions.js", copy=True
    )
    .add_local_file(
        str(REPO_ROOT / "worker/src/lib/ffmpeg.js"), "/app/src/lib/ffmpeg.js", copy=True
    )
)

app = modal.App(APP_NAME, image=image)

# create_if_missing keeps the deploy self-provisioning — no CLI steps beyond
# the secret, which holds a credential and is therefore never auto-created.
renders = modal.Volume.from_name(VOLUME_NAME, create_if_missing=True)
status = modal.Dict.from_name(STATUS_DICT_NAME, create_if_missing=True)
render_secret = modal.Secret.from_name(SECRET_NAME, required_keys=["MODAL_RENDER_SECRET"])


def _check_secret(request) -> None:
    """All endpoints are shared-secret protected (renders cost real compute)."""
    from fastapi import HTTPException  # container-only import (see note above)

    expected = os.environ.get("MODAL_RENDER_SECRET", "")
    provided = request.headers.get("x-render-secret", "")
    if not expected or not hmac.compare_digest(provided, expected):
        raise HTTPException(status_code=401, detail="Invalid or missing X-Render-Secret")


def _public_base(request) -> str:
    """Absolute public base URL of this app, from the proxy-supplied host."""
    host = request.headers.get("host") or ""
    if not host:
        return ""
    return f"https://{host}"


def _notify(webhook_url: str | None, payload: dict) -> None:
    """Best-effort completion callback. The worker also polls /status, so a
    failed callback only costs latency, never the render."""
    if not webhook_url:
        return
    request = urllib.request.Request(
        webhook_url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            response.read()
    except Exception as exc:  # noqa: BLE001 — never fail the render over this
        print(f"[modal-render] webhook callback failed: {exc}")


def _prune_renders() -> None:
    """Drop output files past RENDER_MAX_AGE_S so the Volume stays small."""
    cutoff = time.time() - RENDER_MAX_AGE_S
    try:
        for name in os.listdir(RENDERS_DIR):
            path = os.path.join(RENDERS_DIR, name)
            try:
                if os.path.isfile(path) and os.path.getmtime(path) < cutoff:
                    os.remove(path)
            except OSError:
                continue
    except FileNotFoundError:
        return


@app.function(
    image=image,
    cpu=RENDER_CPU,
    memory=RENDER_MEMORY_MB,
    timeout=RENDER_TIMEOUT_S,
    max_containers=MAX_CONTAINERS,
    volumes={VOLUME_MOUNT: renders},
    secrets=[render_secret],
)
def render_clip(payload: dict) -> dict:
    """Encode one clip with the worker's ffmpeg renderer, then publish the MP4.

    Runs in its own container (spawned by /submit) so the HTTP request never
    waits on the encode.
    """
    render_id = str(payload["renderId"])
    clip_id = str(payload["clipId"])
    spec = payload["spec"]
    webhook_url = payload.get("webhookUrl")

    os.makedirs(CONTAINER_TMP, exist_ok=True)
    os.makedirs(RENDERS_DIR, exist_ok=True)
    _prune_renders()
    status[render_id] = {"status": "rendering", "error": None, "createdAt": time.time()}

    spec_path = os.path.join(CONTAINER_TMP, f"spec-{render_id}.json")
    with open(spec_path, "w", encoding="utf-8") as handle:
        json.dump(spec, handle)

    child_env = {**os.environ, "TMP_DIR": CONTAINER_TMP, "RENDER_THREADS": str(int(RENDER_CPU))}
    
    try:
        proc = subprocess.run(
            ["node", "/app/render-runner.mjs", spec_path, clip_id],
            capture_output=True,
            text=True,
            env=child_env,
            timeout=RENDER_TIMEOUT_S - 120,
        )
    except subprocess.TimeoutExpired:
        message = f"Modal render timed out after {RENDER_TIMEOUT_S - 120}s"
        status[render_id] = {"status": "failed", "error": message, "createdAt": time.time()}
        _notify(webhook_url, {"id": render_id, "status": "failed", "error_message": message})
        raise

    stdout = (proc.stdout or "").strip()
    if proc.returncode != 0:
        # The runner surfaces ffmpeg's stderr tail in its own error message.
        detail = (proc.stderr or stdout or "unknown error").strip()[-1200:]
        message = f"Modal render failed (exit {proc.returncode}): {detail}"
        status[render_id] = {"status": "failed", "error": message, "createdAt": time.time()}
        _notify(webhook_url, {"id": render_id, "status": "failed", "error_message": message})
        raise RuntimeError(message)

    # The runner prints "[render-runner] output <path>"; fall back to the
    # deterministic localRender output name if that line ever moves.
    output_path = ""
    for line in stdout.splitlines():
        if line.startswith("[render-runner] output "):
            output_path = line[len("[render-runner] output ") :].strip()
    if not output_path or not os.path.exists(output_path):
        candidate = os.path.join(CONTAINER_TMP, f"render-local-{clip_id}.mp4")
        if not os.path.exists(candidate):
            message = f"Modal render produced no output file for clip {clip_id}"
            status[render_id] = {"status": "failed", "error": message, "createdAt": time.time()}
            _notify(webhook_url, {"id": render_id, "status": "failed", "error_message": message})
            raise RuntimeError(message)
        output_path = candidate

    stored_path = os.path.join(RENDERS_DIR, f"{render_id}.mp4")
    os.replace(output_path, stored_path)
    renders.commit()  # make the finished file visible to the /download container

    status[render_id] = {
        "status": "done",
        "error": None,
        "file": f"{render_id}.mp4",
        "createdAt": time.time(),
    }
    print(f"[modal-render] {render_id} done ({os.path.getsize(stored_path)} bytes)")

    # Fast path: tell the worker's webhook the clip is ready. The worker also
    # polls /status, so a failed callback only costs latency.
    download_url = payload.get("downloadUrl")
    if download_url:
        _notify(webhook_url, {"id": render_id, "status": "done", "url": download_url})

    return {"renderId": render_id, "file": f"{render_id}.mp4"}


# --- HTTP surface ------------------------------------------------------------

@app.function(image=image, secrets=[render_secret], timeout=150, max_containers=8)
@app.asgi_app()
def web():
    """ASGI app for the worker's render-provider client."""
    from fastapi import FastAPI, HTTPException, Request
    from fastapi.middleware.cors import CORSMiddleware
    from fastapi.responses import FileResponse, JSONResponse

    web_app = FastAPI(title="ClipForge Modal render provider")

    # Handle browser preflight OPTIONS requests
    web_app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @web_app.get("/health")
    def health() -> dict:
        return {"ok": True, "service": APP_NAME}

    @web_app.post("/submit")
    async def submit(request: Request) -> JSONResponse:
        _check_secret(request)
        body = await request.json()

        render_id = str(body.get("renderId") or "").strip()
        clip_id = str(body.get("clipId") or "").strip()
        spec = body.get("spec")
        if not render_id or not clip_id or not isinstance(spec, dict):
            raise HTTPException(status_code=400, detail="renderId, clipId and spec are required")
        if not spec.get("sourceVideoUrl") or not spec.get("durationSeconds"):
            raise HTTPException(
                status_code=400, detail="spec needs sourceVideoUrl and durationSeconds"
            )

        status[render_id] = {"status": "queued", "error": None, "createdAt": time.time()}
        render_clip.spawn(
            {
                "renderId": render_id,
                "clipId": clip_id,
                "spec": spec,
                "webhookUrl": body.get("webhookUrl"),
                "downloadUrl": f"{_public_base(request)}/download/{render_id}",
            }
        )
        return JSONResponse({"ok": True, "renderId": render_id}, status_code=202)

    @web_app.get("/status/{render_id}")
    def render_status(request: Request, render_id: str) -> JSONResponse:
        _check_secret(request)
        record = status.get(render_id)
        if not record:
            return JSONResponse({"status": "rendering", "error": None})
        return JSONResponse(
            {"status": record.get("status", "rendering"), "error": record.get("error")}
        )

    @web_app.get("/download/{render_id}")
    def download(request: Request, render_id: str) -> FileResponse:
        _check_secret(request)
        record = status.get(render_id) or {}
        if record.get("status") != "done":
            raise HTTPException(status_code=409, detail="Render is not finished")
        renders.reload()
        path = os.path.join(RENDERS_DIR, f"{render_id}.mp4")
        if not os.path.isfile(path):
            raise HTTPException(status_code=410, detail="Render output expired")
        return FileResponse(path, media_type="video/mp4", filename=f"{render_id}.mp4")

    return web_app
