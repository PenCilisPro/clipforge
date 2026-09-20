# Node 22 (was required for supabase-js realtime; keep for native fetch/WebSocket parity)
FROM node:22-alpine
# redis-server runs alongside the API (free-plan pattern); python3/make/g++
# are build deps for the worker's gRPC native modules and are removed after.
RUN apk add --no-cache redis python3 make g++ libc6-compat
WORKDIR /app

# Backend deps
COPY backend/package*.json ./
RUN npm install --omit=dev

# Worker deps (BullMQ consumer) — built into the same image and run as a
# background process so one service hosts API + queue + worker.
COPY worker/package*.json /worker/
RUN cd /worker && npm install --omit=dev && apk del python3 make g++

COPY backend/src ./src
COPY backend/start.sh ./start.sh
COPY worker/src /worker/src

# ffmpeg-static ships a bundled binary; keep tmp space for processing
RUN mkdir -p /tmp/clipforge
# Cap the Node heap below the 1GB container limit so V8 GCs before the
# OOM killer takes the whole pod. NODE_OPTIONS is per-process and this
# container runs TWO node processes (API + worker) plus redis and ffmpeg —
# at 512 each they could legally hold 1GB+ of heap before GC pressure,
# leaving nothing for a 4K trim and crash-looping the pod. 256 each keeps
# total node footprint ≤ ~600MB RSS, so a memory-hungry ffmpeg gets OOM-
# killed instead (trimSegment retries at 720p) and the pod survives.
ENV NODE_OPTIONS=--max-old-space-size=256
EXPOSE 4000 6379
# start.sh daemonizes redis, supervises the worker and execs the API.
# (An inline `redis && node worker & exec api` CMD once left redis in the
# foreground of the backgrounded chain, so the worker never started.)
CMD ["sh", "start.sh"]
