"""
Modal yt-dlp downloader for ClipForge — replaces the paid RapidAPI video
downloader with yt-dlp running on Modal's free tier ($30/month of compute,
thousands of downloads), on the SAME infrastructure as the render app.

Why a separate app: modal_render.py is tuned for 4-vCPU/8-GB encode containers;
downloads are network-bound and need ffmpeg only for merging separate
video+audio streams. Independent deploy = independent scaling, and a change
here can never destabilize a working render app.

Protocol (mirrors the render app's auth so the worker configures nothing new):
  GET  /health   → { ok, service }
  POST /download → { url } → the downloaded MP4 (streamed), with
                   X-Video-Duration / X-Video-Title response headers.
Every endpoint requires the shared secret (X-Render-Secret header) — the SAME
header and secret the render app already uses, so no new Modal secret is
needed and the worker reuses MODAL_RENDER_SECRET verbatim.

Audio guarantee: the served file is ffprobe-verified to contain BOTH a video
and an audio stream before it leaves the container — a video-only merge
failure fails loudly here instead of shipping a mute file downstream.

YouTube bot-check note: datacenter IPs sometimes get "Sign in to confirm
you're not a bot". Attempt 1 uses yt-dlp's default player clients; on a
bot-check failure attempt 2 retries with alternate clients. If a video still
fails, the worker falls back to RapidAPI (when RAPIDAPI_KEY is configured).
For hard cases, add a cookies.txt to a Modal secret and set
YTDLP_COOKIES_FILE — the endpoint passes it to every attempt automatically.

Deploy (from the repo root):
    python -m modal deploy modal/modal_download.py
    → set MODAL_DOWNLOAD_URL to the printed URL on the worker service
      (https://<workspace>--clipforge-download-web.modal.run)
No new Modal secret is required — this app reuses "clipforge-render".
"""

import hmac
import json
import os
import subprocess
import time
import uuid
from pathlib import Path
from urllib.parse import quote

import modal

APP_NAME = "clipforge-download"
RENDER_SECRET_NAME = "clipforge-render"  # reused from modal_render.py

CONTAINER_TMP = "/tmp/clipforge"

DOWNLOAD_CPU = 2.0
DOWNLOAD_MEMORY_MB = 2048
DOWNLOAD_TIMEOUT_S = 30 * 60
SUBPROCESS_TIMEOUT_S = 25 * 60
MAX_CONTAINERS = 2
# Matches the 1 GB upload cap with headroom for merge overhead.
MAX_FILESIZE = "2500M"

# Best muxed H.264 mp4 up to 1080p (matches what the RapidAPI path produced),
# with progressive fallbacks so exotic sites still download.
FORMAT = (
    "bv*[ext=mp4][vcodec^=avc1][height<=1080]+ba[ext=m4a]/"
    "bv*[height<=1080]+ba/"
    "b[ext=mp4][height<=1080]/"
    "b"
)
# Second attempt when YouTube's bot check fires on datacenter IPs.
BOTCHECK_PATTERNS = ("sign in to confirm", "not a bot", "precondition check failed")
RETRY_EXTRACTOR_ARGS = "youtube:player_client=tv,web_safari,ios"

image = (
    modal.Image.debian_slim()
    .apt_install("ffmpeg")
    .pip_install("yt-dlp", "fastapi[standard]")
)

app = modal.App(APP_NAME, image=image)
render_secret = modal.Secret.from_name(RENDER_SECRET_NAME, required_keys=["MODAL_RENDER_SECRET"])


def _check_secret(request) -> None:
    """Shared-secret protection (downloads cost bandwidth and CPU)."""
    from fastapi import HTTPException

    expected = os.environ.get("MODAL_RENDER_SECRET", "")
    provided = request.headers.get("x-render-secret", "")
    if not expected or not hmac.compare_digest(provided, expected):
        raise HTTPException(status_code=401, detail="Invalid or missing X-Render-Secret")


def _has_playable_av(path: Path) -> bool:
    """ffprobe check: does this file contain BOTH a video and an audio stream?
    A merged download must have both — audio-only (.m4a) or video-only (.fNNN)
    intermediates are never acceptable final outputs. Fail-open on tooling
    errors (missing ffprobe, timeout): the verifier must never reject a good
    file because IT is broken."""
    for select in ("v", "a"):
        try:
            proc = subprocess.run(
                [
                    "ffprobe", "-v", "error", "-select_streams", select,
                    "-show_entries", "stream=index", "-of", "csv=p=0", str(path),
                ],
                capture_output=True, text=True, timeout=60,
            )
        except (OSError, subprocess.TimeoutExpired):
            return True
        if not proc.stdout.strip():
            return False
    return True


def _run_once(url: str, extra_args: list[str]) -> tuple[Path, dict, str]:
    """One yt-dlp run. Returns (file_path, info_dict, stderr).
    Raises RuntimeError(message, stderr) on failure."""
    out_dir = Path(CONTAINER_TMP)
    out_dir.mkdir(parents=True, exist_ok=True)
    token = uuid.uuid4().hex
    output_template = str(out_dir / f"dl-{token}.%(ext)s")

    cookies = os.environ.get("YTDLP_COOKIES_FILE") or None
    cmd = [
        "yt-dlp",
        "--no-playlist",            # a URL with &list= must not download the playlist
        "--no-warnings",
        "--newline",
        "--concurrent-fragments", "4",
        "--max-filesize", MAX_FILESIZE,
        "--ffmpeg-location", "/usr/bin/ffmpeg",
        "--merge-output-format", "mp4",
        "-f", FORMAT,
        "-o", output_template,
        "--print-json",
        "--no-simulate",            # --print alone would skip the download
    ]
    if cookies:
        cmd += ["--cookies", cookies]
    cmd += extra_args + [url]

    started = time.time()
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=SUBPROCESS_TIMEOUT_S)
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError(
            f"yt-dlp timed out after {SUBPROCESS_TIMEOUT_S}s", str(exc.stderr or "")
        ) from exc

    stderr = proc.stderr or ""
    if proc.returncode != 0:
        tail = (stderr or proc.stdout or "unknown error").strip()[-800:]
        raise RuntimeError(f"yt-dlp exited {proc.returncode}: {tail}", stderr)

    info: dict = {}
    # --print-json --no-simulate prints one info dict per video; take the last
    # parseable JSON line (warnings interleave, so be defensive).
    for line in (proc.stdout or "").splitlines():
        line = line.strip()
        if line.startswith("{"):
            try:
                candidate = json.loads(line)
                if isinstance(candidate, dict) and candidate.get("id"):
                    info = candidate
            except json.JSONDecodeError:
                continue

    # Resolve the actual file: we control the template, --no-playlist and the
    # merge guarantee exactly one output per token. The merged output is
    # dl-<token>.mp4 — prefer it, then fall through the remaining candidates
    # (e.g. .fNNN intermediates if a merge ever fails to clean up) and accept
    # only files ffprobe confirms carry an audio stream. Never serve a
    # video-only file downstream: transcription and every clip would be mute.
    candidates: list[Path] = []
    merged = out_dir / f"dl-{token}.mp4"
    if merged.exists():
        candidates.append(merged)
    candidates.extend(
        p
        for p in sorted(out_dir.glob(f"dl-{token}.*"), key=lambda p: p.stat().st_size, reverse=True)
        if p != merged
    )
    if not candidates:
        raise RuntimeError("yt-dlp finished but produced no output file", stderr)
    file_path = next((p for p in candidates if _has_playable_av(p)), None)
    if file_path is None:
        raise RuntimeError(
            "yt-dlp finished but no output file contains both a video and an "
            "audio stream — refusing to serve a video-only download",
            stderr,
        )
    print(
        f"[modal-download] done in {time.time() - started:.0f}s — "
        f"{file_path.stat().st_size} bytes, title={info.get('title', '?')!r}"
    )
    return file_path, info, stderr


def _download_with_retries(url: str) -> tuple[Path, dict]:
    """Attempt 1: default player clients. Attempt 2 (only on YouTube's
    datacenter-IP bot check): alternate player clients."""
    try:
        file_path, info, _ = _run_once(url, [])
        return file_path, info
    except RuntimeError as exc:
        stderr = exc.args[1] if len(exc.args) > 1 else ""
        lowered = stderr.lower()
        if not any(pattern in lowered for pattern in BOTCHECK_PATTERNS):
            raise

    print("[modal-download] bot check hit — retrying with alternate player clients")
    file_path, info, _ = _run_once(url, ["--extractor-args", RETRY_EXTRACTOR_ARGS])
    return file_path, info


@app.function(
    image=image,
    cpu=DOWNLOAD_CPU,
    memory=DOWNLOAD_MEMORY_MB,
    timeout=DOWNLOAD_TIMEOUT_S,
    max_containers=MAX_CONTAINERS,
    secrets=[render_secret],
)
@modal.asgi_app()
def web():
    from fastapi import FastAPI, HTTPException, Request
    from fastapi.responses import FileResponse, JSONResponse
    from starlette.background import BackgroundTask

    web_app = FastAPI(title="ClipForge Modal yt-dlp downloader")

    @web_app.get("/health")
    def health() -> dict:
        return {"ok": True, "service": APP_NAME}

    @web_app.post("/download")
    async def download(request: Request) -> FileResponse:
        _check_secret(request)
        try:
            body = await request.json()
        except Exception:
            raise HTTPException(status_code=400, detail="Body must be JSON: { url }")

        url = str(body.get("url") or "").strip()
        if not url.lower().startswith(("http://", "https://")):
            raise HTTPException(status_code=400, detail="url must be an http(s) link")

        try:
            file_path, info = _download_with_retries(url)
        except RuntimeError as exc:
            raise HTTPException(status_code=502, detail=str(exc.args[0])[:900])

        duration = info.get("duration")
        title = str(info.get("title") or "source")
        safe_title = title.encode("ascii", "ignore").decode() or "source"
        return FileResponse(
            file_path,
            media_type="video/mp4",
            filename=f"{quote(safe_title)[:80]}.mp4",
            headers={
                "X-Video-Duration": str(duration) if duration else "",
                "X-Video-Title": quote(safe_title),
            },
            background=BackgroundTask(_cleanup, file_path),
        )

    return web_app


def _cleanup(path: Path) -> None:
    """Delete the temp file after the response has finished streaming."""
    try:
        os.remove(path)
    except OSError:
        pass


@app.local_entrypoint()
def main(url: str = "https://www.youtube.com/watch?v=dQw4w9WgXcQ"):
    """Local smoke test: modal run modal/modal_download.py::main --url <link>"""
    file_path, info = _download_with_retries(url)
    print(f"downloaded {file_path} ({file_path.stat().st_size} bytes), {info.get('title')}")
    os.remove(file_path)