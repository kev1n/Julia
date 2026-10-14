#!/bin/bash
# Installs one owner/t3code release on this Mac as soon as nothing would be cut off.
#
#   fork/scripts/deploy-when-idle.sh --schedule <release tag>
#
# copies this script to ~/t3-fork and starts a LaunchAgent that runs it every 30 s
# (log: ~/t3-fork/logs/deploy-when-idle-<sha>.log). Each run downloads and checks the
# release, then waits while live-work.sh (from that release) reports any work: runs, and
# background subagents, shells and Monitors a thread left running after its turn ended.
# There is no timeout: work that stays live keeps the old version running, and every
# check logs what it waits for and since when. A newer release supersedes this one.
set -euo pipefail
export PATH=/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin
export GODEBUG=netdns=go # gh misreads DNS failures as a bad token without it
unset T3CODE_HOME T3_SERVICE_LAUNCHER_CONTEXT T3_BOOT_SERVICE_UNIT
state="$HOME/t3-fork"
mkdir -p "$state/logs" "$state/releases"
if [ "${1:-}" = --schedule ]; then
  tag="${2:?usage: deploy-when-idle.sh --schedule <release tag>}"
  label="com.example.t3code-fork.deploy-when-idle-${tag##*-}"
  plist="$HOME/Library/LaunchAgents/$label.plist"
  # A copy outside any checkout, so the job survives a worktree being removed;
  # a new file, so a job of an earlier tag running the old copy is not disturbed.
  install -S -m 700 "$0" "$state/deploy-when-idle.sh"
  /usr/bin/python3 - "$plist" "$label" "$state" "$tag" <<'PY'
import os, plistlib, sys
path, label, state, tag = sys.argv[1:]
log = os.path.join(state, "logs", label.removeprefix("com.example.t3code-fork.") + ".log")
data = {"Label": label, "ProgramArguments": ["/bin/bash", os.path.join(state, "deploy-when-idle.sh"), tag], "RunAtLoad": True, "StartInterval": 30, "StandardOutPath": log, "StandardErrorPath": log}
os.makedirs(os.path.dirname(path), exist_ok=True)
with open(path, "wb") as f:
    plistlib.dump(data, f)
os.chmod(path, 0o600)
PY
  launchctl bootstrap "gui/$(id -u)" "$plist"
  echo "Scheduled $tag; installation waits until nothing is running, including background work."
  exit 0
fi
tag="${1:?usage: deploy-when-idle.sh <release tag>}"
label="com.example.t3code-fork.deploy-when-idle-${tag##*-}"
plist="$HOME/Library/LaunchAgents/$label.plist"
waiting_since="$state/$label.waiting-since"
finish() {
  rm -f "$waiting_since"
  if [ -f "$plist" ]; then
    mv "$plist" "$state/$label.completed.plist"
    launchctl bootout "gui/$(id -u)/$label" || true
  fi
}
latest=$(gh release view -R owner/t3code --json tagName -q .tagName)
if [ "$latest" != "$tag" ]; then
  echo "$(date -u): $latest superseded $tag; not overwriting it."
  finish
  exit 0
fi
dir="$state/releases/$tag"
if [ ! -f "$dir/VERSION" ]; then
  partial="$dir.partial"
  mkdir -p "$partial"
  gh release download "$tag" -R owner/t3code --clobber -D "$partial"
  target=$(cat "$partial/VERSION")
  while read -r checksum filename; do
    curl -fsS --max-time 240 --retry 2 --output "$partial/$filename" "https://build-mac-host.example.ts.net:8444/$target/$filename"
  done < "$partial/SHA256SUMS"
  (cd "$partial" && shasum -a 256 -c SHA256SUMS)
  mv "$partial" "$dir"
fi
target=$(cat "$dir/VERSION")
if [ ! -d "$dir/scripts" ]; then
  mkdir "$dir/scripts"
  tar -xzf "$dir/fork-scripts.tar.gz" -C "$dir/scripts"
fi
if [ ! -f "$state/desktop-local-build" ] && { [ -d "/Applications/Julia.app" ] || [ -d "/Applications/T3 Code (Owner).app" ]; } && [ "$(cat "$state/desktop-version" 2>/dev/null || true)" != "$target" ]; then
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
# Logs what the restart would cut off and since when; returns 1 while anything is live.
idle() {
  local work
  work=$("$dir/scripts/live-work.sh")
  if [ -z "$work" ]; then
    rm -f "$waiting_since"
    return 0
  fi
  [ -f "$waiting_since" ] || date -u +%s > "$waiting_since"
  local since minutes
  since=$(cat "$waiting_since")
  minutes=$(( ($(date -u +%s) - since) / 60 ))
  echo "$(date -u): $1 $(printf '%s\n' "$work" | wc -l | tr -d ' ') live item(s), waiting since $(date -u -r "$since" +%H:%MZ) (${minutes} min); no restart:"
  printf '%s\n' "$work" | sort | uniq -c | sed 's/^/    /'
  return 1
}
idle "Waiting for" || exit 0
# Check again just before restarting: another release may have arrived during download.
latest=$(gh release view -R owner/t3code --json tagName -q .tagName)
if [ "$latest" != "$tag" ]; then
  echo "$(date -u): $latest superseded $tag during download; not overwriting it."
  finish
  exit 0
fi
idle "Work started during preflight:" || exit 0
echo "$(date -u): Machine is idle (no runs and no background work); installing $target."
if "$dir/scripts/install-runtime.sh" "$dir/t3-$target-darwin-arm64.tar.gz"; then
  echo "$(date -u): Installer verified $target."
else
  echo "$(date -u): Installer failed; its rollback was attempted. Disabling this job for review."
fi
finish
