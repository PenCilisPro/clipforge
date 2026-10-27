# Node 22 (was required for supabase-js realtime; keep for native fetch/WebSocket parity)
FROM node:22-alpine
# redis-server runs alongside the API (free-plan pattern); python3/make/g++
# are build deps for the worker's gRPC native modules and are removed after.
# ffmpeg/fontconfig/font-noto-core are the DISTRO (musl-native) ffmpeg and
# ffprobe: the npm ffmpeg-static / @ffprobe-installer binaries are STATIC
# GLIBC builds whose getaddrinfo cannot resolve DNS under musl — every
# https input failed with "Failed to resolve hostname ...: System error"
# while Node's own fetch resolved the same hosts fine. The distro binaries
# stream R2 presigned URLs natively; fontconfig + a real font keep any
# local libass fallback usable.
RUN apk add --no-cache redis python3 make g++ libc6-compat ffmpeg fontconfig font-noto-core
WORKDIR /app

# Backend deps
COPY backend/package*.json ./
RUN npm install --omit=dev && npm cache clean --force

# Worker deps (BullMQ consumer) — built into the same image and run as a
# background process so one service hosts API + queue + worker.
COPY worker/package*.json /worker/
RUN cd /worker && npm install --omit=dev && npm cache clean --force && apk del python3 make g++

COPY backend/src ./src
COPY backend/start.sh ./start.sh
COPY worker/src /worker/src

# ffmpeg-static ships a bundled binary; keep tmp space for processing
RUN mkdir -p /tmp/clipforge
# Prefer the distro ffmpeg/ffprobe over the bundled static glibc binaries —
# the worker's ffmpeg.js reads these overrides at startup and logs
# "[ffmpeg] using binary: /usr/bin/ffmpeg" on boot.
ENV FFMPEG_PATH_OVERRIDE=/usr/bin/ffmpeg \
    FFPROBE_PATH_OVERRIDE=/usr/bin/ffprobe
# Heap limits are per Node process (API and worker). Source-sized media stays streamed, and local video re-encoding is no longer used for clip renders.
ENV NODE_OPTIONS=--max-old-space-size=128
EXPOSE 4000 6379
# start.sh daemonizes redis, supervises the worker and execs the API.
# (An inline `redis && node worker & exec api` CMD once left redis in the
# foreground of the backgrounded chain, so the worker never started.)
CMD ["sh", "start.sh"]