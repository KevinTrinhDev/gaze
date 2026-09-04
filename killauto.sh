#!/usr/bin/env bash
# Kill only the automation browser, identified by who owns the listening debug
# port, never the operator's everyday browser.
#
# Why this file exists at all: `pkill -f <pattern>` matches its own shell and
# kills the caller (exit 144). Resolving the pid from the port avoids that.
set -uo pipefail
PORT="${1:-9225}"

port_pid() {
  ss -ltnp 2>/dev/null | grep ":$PORT " | grep -oP 'pid=\K[0-9]+' | head -1
}

PID=$(port_pid)
if [ -z "$PID" ]; then
  echo "nothing listening on :$PORT"
  exit 0
fi

# `start` launches the browser under setsid, so it owns its own process group.
# Signalling the GROUP reaps the renderer and zygote children with it; the old
# bare `kill "$PID"` left them orphaned. Never group-kill our own group, which
# is the same mistake as pkill -f in a different costume.
PGID=$(ps -o pgid= -p "$PID" 2>/dev/null | tr -d ' ')
MY_PGID=$(ps -o pgid= -p "$$" 2>/dev/null | tr -d ' ')

signal() {
  if [ -n "$PGID" ] && [ "$PGID" != "$MY_PGID" ]; then
    kill -"$1" -- "-$PGID" 2>/dev/null || kill -"$1" "$PID" 2>/dev/null
  else
    kill -"$1" "$PID" 2>/dev/null
  fi
}

# Callers delete the profile directory as soon as this returns, so actually
# waiting for the port to close is the difference between a clean sync and an
# `rm -rf` racing a browser that is still flushing its own profile.
wait_gone() {
  local tries="$1"
  while [ "$tries" -gt 0 ]; do
    [ -z "$(port_pid)" ] && return 0
    sleep 0.25
    tries=$((tries - 1))
  done
  return 1
}

signal TERM
if wait_gone 40; then
  echo "killed pid $PID on :$PORT"
  exit 0
fi

signal KILL
if wait_gone 20; then
  echo "killed pid $PID on :$PORT (needed SIGKILL)"
  exit 0
fi

echo "could not free :$PORT (pid $PID is still listening)" >&2
exit 1
