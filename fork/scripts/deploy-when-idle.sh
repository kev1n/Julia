#!/bin/bash
# Installs one release of the fork on this Mac as soon as nothing would be cut off.
#
#   fork/scripts/deploy-when-idle.sh --schedule <release tag> [--now]
#   fork/scripts/deploy-when-idle.sh --cancel <release tag>
#
# --schedule copies this script to ~/t3-fork and starts a LaunchAgent that runs it
# every 30 s (log: ~/t3-fork/logs/deploy-when-idle-<sha>.log). Each run downloads and
# checks the release, then asks the running server what a restart would cut off (runs,
# and background subagents, shells and Monitors a thread left running after its turn
# ended) without changing anything, and waits while that is anything. Once it is
# nothing, the run starts the server's drain (apps/server/src/fork/drain.ts), which
# refuses new threads, messages and delegated tasks, and installs if the drain also
# answers idle; if work began meanwhile it cancels the drain and waits again. So new
# work is refused only for the seconds between idle and the restart.
# Scheduled from an agent's shell, the agent's own thread is left out, so an agent
# can wait for its deploy. A server without the drain (a release before it, or no
# ~/.t3/userdata/fork-fleet.json) is checked with live-work.sh instead.
# There is no timeout: work that stays live keeps the old version running, and every
# check logs what it waits for and since when. A newer release supersedes this one.
# --now installs without waiting, cutting off whatever runs. --cancel removes the job
# and ends its drain, so the server takes new work again.
set -euo pipefail
export PATH=/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin
export GODEBUG=netdns=go # gh misreads DNS failures as a bad token without it
unset T3CODE_HOME T3_SERVICE_LAUNCHER_CONTEXT T3_BOOT_SERVICE_UNIT
usage="usage: deploy-when-idle.sh [--schedule | --cancel] <release tag> [--now] [--requester <provider session id>]"
action=run now=0 requester="" tag=""
while [ $# -gt 0 ]; do
  case "$1" in
    --schedule) action=schedule ;;
    --cancel) action=cancel ;;
    --now) now=1 ;;
    --requester) requester="${2:?$usage}"; shift ;;
    -*) echo "$usage" >&2; exit 2 ;;
    *) tag="$1" ;;
  esac
  shift
done
[ -n "$tag" ] || { echo "$usage" >&2; exit 2; }
. "$(dirname "$0")/fork.env" # fork_repo, artifacts_url, job_label_prefix
fork_require fork_repo artifacts_url || exit 1
state="$HOME/t3-fork"
mkdir -p "$state/logs" "$state/releases"
label="$job_label_prefix.deploy-when-idle-${tag##*-}"
plist="$HOME/Library/LaunchAgents/$label.plist"
if [ "$action" = schedule ]; then
  # The agent scheduling this, if any: Claude and Codex give their shells their own id.
  requester="${CLAUDE_CODE_SESSION_ID:-${CODEX_THREAD_ID:-}}"
  # A copy outside any checkout, so the job survives a worktree being removed;
  # a new file, so a job of an earlier tag running the old copy is not disturbed.
  install -S -m 600 "$(dirname "$0")/fork.env" "$state/fork.env"
  install -S -m 700 "$0" "$state/deploy-when-idle.sh"
  /usr/bin/python3 - "$plist" "$label" "$state" "$tag" "$now" "$requester" "$job_label_prefix" <<'PY'
import os, plistlib, sys
path, label, state, tag, now, requester, prefix = sys.argv[1:]
log = os.path.join(state, "logs", label.removeprefix(prefix + ".") + ".log")
args = ["/bin/bash", os.path.join(state, "deploy-when-idle.sh"), tag]
extra = ["--now"] if now == "1" else []
extra += ["--requester", requester] if requester else []
data = {"Label": label, "RunAtLoad": True, "StartInterval": 30}
# On a Mac whose ~/t3-fork is on a removable volume, only ExternalLauncher.app holds the
# macOS access grant: it runs the job's script itself and writes the log above, so
# launchd's own log and working directory stay on the internal disk.
launcher = os.path.expanduser("~/Applications/ExternalLauncher.app/Contents/MacOS/ExternalLauncher")
if os.access(launcher, os.X_OK):
    args = [launcher, "t3-deploy-when-idle", tag]
    log = os.path.expanduser("~/Library/Logs/external-launcher/" + label + ".log")
    os.makedirs(os.path.dirname(log), exist_ok=True)
    data["WorkingDirectory"] = os.path.dirname(log)
data.update({"ProgramArguments": args + extra, "StandardOutPath": log, "StandardErrorPath": log})
os.makedirs(os.path.dirname(path), exist_ok=True)
with open(path, "wb") as f:
    plistlib.dump(data, f)
os.chmod(path, 0o600)
PY
  launchctl bootstrap "gui/$(id -u)" "$plist"
  if [ "$now" = 1 ]; then
    echo "Scheduled $tag to install now, cutting off whatever runs."
  else
    echo "Scheduled $tag; the server stops taking new work and installs once nothing is running${requester:+ but this thread}."
  fi
  exit 0
fi
waiting_since="$state/$label.waiting-since"
finish() {
  rm -f "$waiting_since"
  if [ -f "$plist" ]; then
    mv "$plist" "$state/$label.completed.plist"
    launchctl bootout "gui/$(id -u)/$label" || true
  fi
}
# POSTs one drain action ($1: start or cancel) to the server on this Mac and prints its
# JSON answer. Exits 2 when the server has no drain, 1 when the request failed.
drain() {
  local secret answer body
  secret=$(/usr/bin/python3 -c 'import json,os; print(json.load(open(os.path.expanduser("~/.t3/userdata/fork-fleet.json")))["secret"])' 2>/dev/null) || return 2
  body=$(/usr/bin/python3 -c 'import json,sys; print(json.dumps({"action": sys.argv[1], "release": sys.argv[2], **({"requester": sys.argv[3]} if sys.argv[3] else {})}))' "$1" "$tag" "$requester")
  # The secret goes in on stdin, never in an argument other processes can read.
  answer=$(printf 'Authorization: Bearer %s\n' "$secret" |
    curl -sS --max-time 5 -H @- -H 'Content-Type: application/json' --data "$body" \
      -w '\n%{http_code}' http://127.0.0.1:3773/fork/fleet/drain) || return 1
  case "${answer##*$'\n'}" in
    200) printf '%s\n' "${answer%$'\n'*}" ;;
    404) return 2 ;;
    *) return 1 ;;
  esac
}
cancel_drain() {
  drain cancel > /dev/null || true
}
if [ "$action" = cancel ]; then
  finish
  cancel_drain
  echo "Cancelled $tag; the server takes new work again."
  exit 0
fi
latest=$(gh release view -R "$fork_repo" --json tagName -q .tagName)
if [ "$latest" != "$tag" ]; then
  echo "$(date -u): $latest superseded $tag; not overwriting it."
  cancel_drain
  finish
  exit 0
fi
dir="$state/releases/$tag"
if [ ! -f "$dir/VERSION" ]; then
  partial="$dir.partial"
  mkdir -p "$partial"
  gh release download "$tag" -R "$fork_repo" --clobber -D "$partial"
  target=$(cat "$partial/VERSION")
  while read -r checksum filename; do
    curl -fsS --max-time 240 --retry 2 --output "$partial/$filename" "$artifacts_url/$target/$filename"
  done < "$partial/SHA256SUMS"
  (cd "$partial" && shasum -a 256 -c SHA256SUMS)
  mv "$partial" "$dir"
fi
target=$(cat "$dir/VERSION")
if [ ! -d "$dir/scripts" ]; then
  mkdir "$dir/scripts"
  tar -xzf "$dir/fork-scripts.tar.gz" -C "$dir/scripts"
fi
if [ ! -f "$state/desktop-local-build" ] && fork_desktop_installed && [ "$(cat "$state/desktop-version" 2>/dev/null || true)" != "$target" ]; then
  "$dir/scripts/install-desktop.sh" "$dir"/T3-Code-*-arm64.zip
  echo "$target" > "$state/desktop-version"
fi
if [ -f "$state/desktop-local-build" ]; then
  echo "$(date -u): Desktop local-build guard present; leaving the desktop app untouched."
fi
active=$(/usr/bin/python3 -c 'import json,os; print(json.load(open(os.path.expanduser("~/.t3/runtime/service-state.json")))["activeVersion"])')
reported=$(curl -fsS --max-time 5 http://127.0.0.1:3773/.well-known/t3/environment | /usr/bin/python3 -c 'import json,sys; print(json.load(sys.stdin)["serverVersion"])')
if [ "$active" = "$target" ] && [ "$reported" = "$target" ]; then
  echo "$(date -u): Verified server runs $target."
  finish
  exit 0
fi
# Logs what the restart would cut off ($2, one item per line) and since when;
# returns 1 while there is anything.
report() {
  if [ -z "$2" ]; then
    rm -f "$waiting_since"
    return 0
  fi
  [ -f "$waiting_since" ] || date -u +%s > "$waiting_since"
  local since minutes
  since=$(cat "$waiting_since")
  minutes=$(( ($(date -u +%s) - since) / 60 ))
  echo "$(date -u): $1 $(printf '%s\n' "$2" | wc -l | tr -d ' ') live item(s), waiting since $(date -u -r "$since" +%H:%MZ) (${minutes} min); no restart:"
  printf '%s\n' "$2" | sort | uniq -c | sed 's/^/    /'
  return 1
}
# The fallback for a server without the drain. Returns 1 while anything is live
# or live-work.sh fails.
idle() {
  local work code=0
  # Called as `idle || exit 0`, so errexit is off here: check the status ourselves.
  work=$("$dir/scripts/live-work.sh") || code=$?
  if [ "$code" != 0 ]; then
    echo "$(date -u): live-work.sh failed (exit $code); no restart, trying again at the next run."
    return 1
  fi
  report "$1" "$work"
}
# Logs a drain answer ($2) and returns 0 when it reports nothing left to cut off.
answered() {
  local work
  work=$(printf '%s' "$2" | /usr/bin/python3 -c '
import json, sys
answer = json.load(sys.stdin)
for item in answer["notWaitingFor"]:
    print("Not waiting for the thread that scheduled this deploy: %s %s %s" % (item["kind"], item["title"], item["what"]), file=sys.stderr)
for item in answer["waitingFor"]:
    print("\t".join((item["kind"], item["title"], item["what"])))
') || {
    echo "$(date -u): Unreadable drain answer; no restart, trying again at the next run."
    return 1
  }
  report "$1" "$work"
}
# Asks the server, without draining, whether anything is live; returns 0 when not.
quiet() {
  local answer code=0
  answer=$(drain peek) || code=$?
  if [ "$code" = 2 ]; then
    fallback=1
    echo "$(date -u): The running server has no drain; checking live-work.sh instead."
    idle "Waiting for"
    return
  fi
  if [ "$code" != 0 ]; then
    echo "$(date -u): Live work request failed; no restart, trying again at the next run."
    return 1
  fi
  answered "Waiting for" "$answer"
}
# Starts the drain once idle; returns 0 when its answer is idle too. Otherwise
# work began meanwhile: cancel the drain at once, so new work is taken again.
drain_started() {
  local answer
  if answer=$(drain start) && answered "Work started as the drain began:" "$answer"; then
    return 0
  fi
  cancel_drain
  echo "$(date -u): Drain cancelled; new work is taken again until the next run."
  return 1
}
fallback=0
if [ "$now" = 1 ]; then
  echo "$(date -u): Forced deploy (--now): not waiting for running work."
else
  quiet || exit 0
fi
# Check again just before restarting: another release may have arrived during download.
latest=$(gh release view -R "$fork_repo" --json tagName -q .tagName)
if [ "$latest" != "$tag" ]; then
  echo "$(date -u): $latest superseded $tag during download; not overwriting it."
  cancel_drain
  finish
  exit 0
fi
if [ "$now" != 1 ]; then
  if [ "$fallback" = 1 ]; then
    idle "Work started during preflight:" || exit 0
  else
    drain_started || exit 0
  fi
fi
if [ "$now" = 1 ]; then
  echo "$(date -u): Installing $target now (--now), cutting off whatever runs."
else
  echo "$(date -u): Nothing left to cut off; installing $target."
fi
if "$dir/scripts/install-runtime.sh" "$dir/t3-$target-darwin-arm64.tar.gz"; then
  echo "$(date -u): Installer verified $target."
else
  echo "$(date -u): Installer failed; its rollback was attempted. Disabling this job for review."
  cancel_drain
fi
finish
