#!/usr/bin/env bash
# kill only the automation Brave (by listening port owner), never the user's Brave
PORT="${1:-9225}"
PID=$(ss -ltnp 2>/dev/null | grep ":$PORT " | grep -oP 'pid=\K[0-9]+' | head -1)
if [ -n "$PID" ]; then
  # walk to the top-level brave process
  kill "$PID" 2>/dev/null && echo "killed pid $PID on :$PORT"
else
  echo "nothing listening on :$PORT"
fi
