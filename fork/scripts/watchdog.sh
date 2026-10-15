#!/bin/bash
# Every minute on every Mac (LaunchAgent com.example.t3code-fork.watchdog):
# restart the T3 service when it has stopped answering on localhost for three
# checks in a row, or when its memory passes a ceiling. A hung server shows as
# "<machine> is reconnecting" on every client until someone restarts it
# (2026-10-15: the MacBook's server grew to 234 GB inside Node's HTTP/2 write
# queue and stopped answering for good). Before restarting it saves a 5 s
# `sample` of the process to logs/, so the cause can still be found.
set -uo pipefail
state="$HOME/t3-fork"
label="com.t3tools.t3code.service"
port=3773
failures_to_restart=3
max_rss_kb=$((12 * 1024 * 1024))
# A deploy or rollback switches activeVersion and restarts the service; leave
# that restart alone for this long.
deploy_grace_seconds=300
mkdir -p "$state/logs"
exec >> "$state/logs/watchdog.log" 2>&1
counter="$state/watchdog.failures"
now=$(date +%s)

launchctl print "gui/$(id -u)/$label" > /dev/null 2>&1 || exit 0
service_state="$HOME/.t3/runtime/service-state.json"
if [ -f "$service_state" ] && [ $((now - $(stat -f %m "$service_state"))) -lt $deploy_grace_seconds ]; then
  exit 0
fi
if [ -f "$counter.restarted" ] && [ $((now - $(stat -f %m "$counter.restarted"))) -lt $deploy_grace_seconds ]; then
  exit 0
fi

pid=$(lsof -nP -t -iTCP:$port -sTCP:LISTEN 2>/dev/null | head -1)
reason=""
if [ -n "$pid" ]; then
  rss_kb=$(ps -o rss= -p "$pid" | tr -d ' ')
  if [ -n "$rss_kb" ] && [ "$rss_kb" -gt "$max_rss_kb" ]; then
    reason="memory $((rss_kb / 1024)) MB over $((max_rss_kb / 1024)) MB"
  fi
fi
if [ -z "$reason" ]; then
  if [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "http://127.0.0.1:$port/api/health")" = "200" ]; then
    rm -f "$counter"
    exit 0
  fi
  failures=$(($(cat "$counter" 2>/dev/null || echo 0) + 1))
  echo "$failures" > "$counter"
  echo "$(date) health check failed ($failures/$failures_to_restart)"
  [ "$failures" -ge "$failures_to_restart" ] || exit 0
  reason="no health response for $failures checks"
fi

echo "$(date) restarting $label (pid ${pid:-none}): $reason"
if [ -n "$pid" ]; then
  sample "$pid" 5 -file "$state/logs/watchdog-sample-$(date +%Y%m%d-%H%M%S).txt" > /dev/null 2>&1
  ls -t "$state"/logs/watchdog-sample-*.txt 2>/dev/null | tail -n +6 | xargs rm -f
fi
launchctl kickstart -k "gui/$(id -u)/$label"
rm -f "$counter"
touch "$counter.restarted"
/usr/bin/osascript -e "display notification \"$reason. A stack sample is in ~/t3-fork/logs.\" with title \"T3 server restarted on $(hostname -s)\"" > /dev/null 2>&1 || true
