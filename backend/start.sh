#!/bin/sh
# Combined API + worker + ephemeral in-container Redis (one service hosts all).
# Queue data is intentionally ephemeral: it is lost on redeploy. The worker
# re-enqueues clips stranded without a queue entry on startup (recovery.js).
#
# IMPORTANT: redis must run with --daemonize yes. A foreground redis inside a
# backgrounded `redis && node worker &` chain never exits, so the worker node
# process would never start and every queued clip would sit forever (this
# exact bug shipped once — keep the daemonize flag).
# maxmemory is mandatory, not optional: Redis shares one 512 MB container
# with the API, the worker and transient ffmpeg processes, and an unbounded
# queue store (dead letters, delayed publishing jobs, stalled-check state)
# would eventually eat the container and OOM-kill everything. noeviction is
# the only policy BullMQ supports — evicting job keys silently loses jobs.
redis-server \
  --port 6379 \
  --save "" \
  --appendonly no \
  --maxmemory 96mb \
  --maxmemory-policy noeviction \
  --daemonize yes

# Locate the worker source (Docker image copies it to /worker; a repo
# checkout has it next to backend/).
WORKER_ENTRY=""
for candidate in /worker/src/index.js "$(dirname "$0")/../worker/src/index.js"; do
  if [ -f "$candidate" ]; then
    WORKER_ENTRY="$candidate"
    break
  fi
done

if [ -n "$WORKER_ENTRY" ]; then
  # Supervise-loop: if the worker crashes, restart it after a short pause so
  # an API-only container never silently stops consuming the queue.
  (
    while :; do
      node "$WORKER_ENTRY"
      echo "[start] worker exited — restarting in 5s" >&2
      sleep 5
    done
  ) &
else
  echo "[start] worker entry not found — API will serve but queue will not drain" >&2
fi

exec node src/server.js
