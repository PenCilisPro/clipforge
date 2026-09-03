#!/bin/sh
# Launch an ephemeral in-container Redis, then the API.
# Workers in the same Railway project reach it at
# redis://backend.railway.internal:6379 (private networking).
redis-server \
  --port 6379 \
  --save "" \
  --appendonly no \
  --daemonize yes

exec node src/server.js
