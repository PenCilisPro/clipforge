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
#
# ROLE splits the two halves across services without touching the image:
#
#   ROLE=all     (default) API + Redis + worker in one container — as before.
#   ROLE=api     Redis + API only. Point the worker service's REDIS_URL at
#                this container (Northflank private network:
#                redis://<api-service-internal-hostname>:6379 — port 6379 is
#                already EXPOSEd in the Dockerfile).
#   ROLE=worker  Worker only, in the foreground (supervised restart loop).
#                Give THIS service the CPU-heavy plan: local video encoding
#                needs real cores, and rendering next to the API on a ~0.2
#                vCPU box starves every request for minutes during encodes
#                (observed 300-519s GET /api/projects, gateway CORS-less
#                timeout pages, tokens expiring mid-request). The worker
#                also needs the same Firebase/Firestore/R2 env vars as the
#                API container, plus REDIS_URL.
#
# One worker drains the queue — running one here AND one in the API
# container is also fine (BullMQ jobs are claimed atomically), so migrating
# is zero-downtime: deploy the worker service first, then flip the API
# container's ROLE to api.
ROLE="${ROLE:-all}"

locate_worker_entry() {
  for candidate in /worker/src/index.js "$(dirname "$0")/../worker/src/index.js"; do
    if [ -f "$candidate" ]; then
      echo "$candidate"
      return 0
    fi
  done
  return 1
}

if [ "$ROLE" = "worker" ]; then
  WORKER_ENTRY="$(locate_worker_entry)" || {
    echo "[start] ROLE=worker but worker entry not found" >&2
    exit 1
  }
  # A worker-only container has no local Redis. Without REDIS_URL the driver
  # defaults to 127.0.0.1:6379, connects to nothing and the queue silently
  # never drains — fail loudly at boot instead of haunting the logs.
  if [ -z "$REDIS_URL" ]; then
    echo "[start] FATAL: ROLE=worker requires REDIS_URL pointing at the API" \
         "service's internal Redis (e.g. redis://<api-internal-address>:6379)." \
         "Refusing to start with the useless 127.0.0.1 default." >&2
    exit 1
  fi
  # Foreground supervision: PID 1 stays alive, crashes restart after 5s.
  while :; do
    node "$WORKER_ENTRY"
    echo "[start] worker exited — restarting in 5s" >&2
    sleep 5
  done
fi

# Redis 7's protected mode refuses every non-loopback client — that includes
# a ROLE=worker container reaching this queue over Northflank's private
# network. --protected-mode no is safe here because the port must only ever
# be published as an INTERNAL (project-private) port — never public. For
# defense in depth set REDIS_PASSWORD on BOTH services; workers then connect
# with redis://:<password>@<internal-address>:6379.
if [ -n "$REDIS_PASSWORD" ]; then
  redis-server \
    --port 6379 \
    --requirepass "$REDIS_PASSWORD" \
    --save "" \
    --appendonly no \
    --maxmemory 96mb \
    --maxmemory-policy noeviction \
    --protected-mode no \
    --daemonize yes
else
  redis-server \
    --port 6379 \
    --save "" \
    --appendonly no \
    --maxmemory 96mb \
    --maxmemory-policy noeviction \
    --protected-mode no \
    --daemonize yes
fi

if [ "$ROLE" != "api" ]; then
  # Supervise-loop: if the worker crashes, restart it after a short pause so
  # an API-only container never silently stops consuming the queue.
  WORKER_ENTRY="$(locate_worker_entry)" && {
    (
      while :; do
        node "$WORKER_ENTRY"
        echo "[start] worker exited — restarting in 5s" >&2
        sleep 5
      done
    ) &
  } || {
    echo "[start] worker entry not found — API will serve but queue will not drain" >&2
  }
fi

exec node src/server.js
