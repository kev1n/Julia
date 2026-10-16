#!/bin/bash
# Daily on every Mac (LaunchAgent com.example.t3code-fork.deploy): install the
# newest owner/t3code release if this Mac does not run it yet. Server runtime
# on every Mac; the desktop app too where Julia or the legacy fork app is installed.
# Waits for a later run while any thread is working or has background work
# live (live-work.sh); when there is none it hands the install to a
# deploy-when-idle.sh job, which drains the server first, so a deploy never
# cuts either off. On the MacBook it
# also raises a notification while a "Fork sync failed" issue is open.
set -uo pipefail
fork_repo="owner/t3code"
# Build outputs served by build-mac over the tailnet (see install-jobs.sh artifacts).
artifacts_url="https://build-mac-host.example.ts.net:8444"
state="$HOME/t3-fork"
mkdir -p "$state/logs" "$state/releases"
exec >> "$state/logs/deploy.log" 2>&1
export GODEBUG=netdns=go # gh misreads DNS failures as a bad token without it
export PATH="/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
echo "== deploy check $(date)"

if [ -d "/Applications/Julia.app" ] || [ -d "/Applications/T3 Code (Owner).app" ]; then
  failed=$(gh issue list -R "$fork_repo" --state open --search "\"Fork sync failed\" in:title" --json url -q '.[0].url' 2>/dev/null)
  [ -n "$failed" ] && /usr/bin/osascript -e "display notification \"Nothing was deployed. Details: $failed\" with title \"T3 Code fork sync failed\""
fi

tag=$(gh release list -R "$fork_repo" --exclude-drafts --limit 1 --json tagName -q '.[0].tagName') || exit 1
[ -n "$tag" ] || { echo "no release"; exit 0; }
dir="$state/releases/$tag"
if [ ! -f "$dir/VERSION" ]; then
  rm -rf "$dir.partial"
  gh release download "$tag" -R "$fork_repo" -D "$dir.partial" || exit 1
  v=$(cat "$dir.partial/VERSION")
  for file in $(awk '{print $2}' "$dir.partial/SHA256SUMS"); do
    curl -fsS --output "$dir.partial/$file" "$artifacts_url/$v/$file" || exit 1
  done
  (cd "$dir.partial" && shasum -a 256 -c SHA256SUMS) || exit 1
  mv "$dir.partial" "$dir"
fi
version=$(cat "$dir/VERSION")
# Install with the scripts that shipped in the release, so they stay in step with it.
scripts="$dir/scripts"
[ -d "$scripts" ] || { mkdir -p "$scripts" && tar -xzf "$dir/fork-scripts.tar.gz" -C "$scripts"; }
active=$(/usr/bin/python3 -c 'import json,os; print(json.load(open(os.path.expanduser("~/.t3/runtime/service-state.json")))["activeVersion"])')

if [ "$active" != "$version" ]; then
  # Runs, and background subagents, shells and Monitors left running after a turn ended.
  if ! work=$("$scripts/live-work.sh"); then
    echo "Could not read live work; leaving $active in place until the next run."
  elif [ -n "$work" ]; then
    echo "$(printf '%s\n' "$work" | wc -l | tr -d ' ') live item(s); leaving $active in place until the next run:"
    printf '%s\n' "$work" | sort | uniq -c | sed 's/^/    /'
  else
    # Idle now: the deploy-when-idle job drains the server first, so work that
    # starts before the restart is refused instead of cut off.
    "$scripts/deploy-when-idle.sh" --schedule "$tag"
  fi
fi

if { [ -d "/Applications/Julia.app" ] || [ -d "/Applications/T3 Code (Owner).app" ]; } && [ "$(cat "$state/desktop-version" 2>/dev/null)" != "$version" ]; then
  "$scripts/install-desktop.sh" "$(ls "$dir"/T3-Code-*-arm64.zip)" && echo "$version" > "$state/desktop-version"
fi
# Keep the downloads of this release and the one before it.
ls -1dt "$state/releases"/*/ 2>/dev/null | tail -n +3 | xargs rm -rf
