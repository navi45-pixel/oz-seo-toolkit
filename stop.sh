#!/bin/bash
# stop.sh — stop the OzSEO Toolkit server running on its port.
#
# Dual mode:
#   executed directly ("npm stop" / "bash stop.sh") → stops the server
#   sourced by start.sh → provides the shared port helpers, no side effects
#
# Mirrors the start.sh takeover logic: find LISTENING pids on $PORT, try a
# graceful close first, then force-kill anything still holding the port.

# ---------- shared helpers (also used by start.sh) ----------
oz_normalize_port() {
  # Validate PORT_EXPECTED, then PORT; export PORT as a usable port number.
  # A host-set PORT=0 or PORT=abc would make Node pick a RANDOM port, breaking
  # the live preview — anything non-numeric or out of range is neutralized.
  case "${PORT_EXPECTED:-}" in
    ''|*[!0-9]*) PORT_EXPECTED=3000 ;;
  esac
  if [ "$PORT_EXPECTED" -lt 1 ] || [ "$PORT_EXPECTED" -gt 65535 ]; then
    PORT_EXPECTED=3000
  fi
  if [ -n "${PORT:-}" ]; then
    case "$PORT" in
      ''|*[!0-9]*)
        echo "→ Neutralizing bad PORT='$PORT' (not a number in 1-65535) — using $PORT_EXPECTED"
        unset PORT
        ;;
      *)
        if [ "$PORT" -lt 1 ] || [ "$PORT" -gt 65535 ]; then
          echo "→ Neutralizing bad PORT='$PORT' (out of range 1-65535) — using $PORT_EXPECTED"
          unset PORT
        elif [ "$PORT" -ne "$PORT_EXPECTED" ]; then
          echo "→ PORT=$PORT overrides default $PORT_EXPECTED"
        fi
        ;;
    esac
  fi
  export PORT="${PORT:-$PORT_EXPECTED}"
}

oz_port_pids() {
  # PIDs of processes LISTENING on $PORT — cross-platform (Linux / Git Bash).
  if [ "$(uname -s)" = "Linux" ]; then
    fuser "$PORT/tcp" 2>/dev/null | tr -s ' \t' '\n\n' | grep -v '^$' || true
  else
    # Windows / Git Bash: netstat (col2 = local address, col5 = PID)
    netstat -ano 2>/dev/null | awk -v p=":$PORT" '$2 ~ p && $4 == "LISTENING" {print $5}' | sort -u
  fi
}

oz_kill_port() {
  # Stop whatever LISTENS on $PORT: graceful close first, force-kill as fallback.
  # Returns 0 if there was something to kill, 1 if the port was already free.
  local pids pid
  pids=$(oz_port_pids)
  if [ -z "$pids" ]; then
    return 1
  fi
  for pid in $pids; do
    [ "$pid" = "0" ] && continue
    if [ "$(uname -s)" = "Linux" ]; then
      kill "$pid" 2>/dev/null || true
    else
      taskkill //PID "$pid" >/dev/null 2>&1 || true
    fi
  done
  sleep 1
  pids=$(oz_port_pids)
  for pid in $pids; do
    [ "$pid" = "0" ] && continue
    if [ "$(uname -s)" = "Linux" ]; then
      kill -9 "$pid" 2>/dev/null || true
    else
      taskkill //F //PID "$pid" >/dev/null 2>&1 || true
    fi
  done
  sleep 1
  return 0
}

# ---------- direct execution: stop the server ----------
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  set -u
  cd "$(dirname "$0")"

  oz_normalize_port
  echo "→ Looking for the OzSEO server on port $PORT..."

  if oz_kill_port; then
    if [ -z "$(oz_port_pids)" ]; then
      echo "✓ Stopped: port $PORT is free."
      exit 0
    else
      echo "✗ Something is still listening on port $PORT — kill it manually." >&2
      exit 1
    fi
  fi

  echo "Nothing is listening on port $PORT — nothing to stop."
  exit 0
fi
