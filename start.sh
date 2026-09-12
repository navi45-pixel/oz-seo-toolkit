#!/bin/bash
# Self-healing launcher for the OzSEO Toolkit.
#  1. reinstalls dependencies if the sandbox reset wiped them
#  2. neutralizes a broken PORT env (e.g. PORT=0 or PORT=abc) that would make
#     Node pick a random port — the live preview / frontend expects 3000
#  3. takes over the port if a stale instance is running (via stop.sh helpers)
#  4. starts the server and VERIFIES /api/health answers before declaring success
set -u
cd "$(dirname "$0")"

PORT_EXPECTED="${PORT_EXPECTED:-3000}"

# ---------- shared port helpers from stop.sh ----------
source "$(dirname "$0")/stop.sh"

# ---------- 1. dependencies ----------
if [ ! -d node_modules/express ] || [ ! -d node_modules/cheerio ]; then
  echo "→ Installing dependencies..."
  npm install express cheerio --no-audit --no-fund --silent || {
    echo "✗ npm install failed" >&2; exit 1; }
fi

# ---------- 2. normalize PORT (shared helper) ----------
oz_normalize_port

# ---------- 3. take over the port if it's busy ----------
if command -v curl >/dev/null 2>&1 && curl -s -o /dev/null --max-time 3 "http://localhost:$PORT/api/health"; then
  echo "→ Something is already listening on port $PORT — stopping it so this launch can take over."
  oz_kill_port
fi

# ---------- 4. start + health-check ----------
echo "→ Starting OzSEO Toolkit on port $PORT..."
nohup node server.js > server.log 2>&1 &
SERVER_PID=$!

# Poll /api/health until it answers (or give up)
HEALTH_OK=""
for i in $(seq 1 20); do
  sleep 0.5
  if curl -s --max-time 2 "http://localhost:$PORT/api/health" | grep -q '"ok":true'; then
    HEALTH_OK=1
    break
  fi
  # Fail fast if the process already died (e.g. EADDRINUSE after the takeover kill failed)
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "✗ Server process exited during startup — last log lines:" >&2
    tail -5 server.log >&2 || true
    exit 1
  fi
done

if [ -z "$HEALTH_OK" ]; then
  echo "✗ Server did not answer /api/health within 10s — last log lines:" >&2
  tail -5 server.log >&2 || true
  exit 1
fi

echo "✓ OzSEO Toolkit is up: http://localhost:$PORT  (pid $SERVER_PID, log: server.log)"
