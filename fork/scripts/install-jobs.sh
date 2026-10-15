#!/bin/bash
# Install the fork's LaunchAgents on this Mac (idempotent).
#   fork/scripts/install-jobs.sh deploy        every Mac: daily pull of the newest release
#   fork/scripts/install-jobs.sh watchdog      every Mac: restart a hung T3 service (each
#                                              release's installer refreshes it)
#   fork/scripts/install-jobs.sh sync artifacts deploy
#                                              the build Mac (build-mac): daily sync + build, and
#                                              its build outputs served to the tailnet on :8444
# Times are local: sync at 05:00, deploy at 05:45 (a missed run, e.g. while the
# MacBook sleeps, runs at wake).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
state="$HOME/t3-fork"
mkdir -p "$state/logs" "$HOME/Library/LaunchAgents"
install_job() {
  local label=$1 script=$2 hour=$3 minute=$4
  local plist="$HOME/Library/LaunchAgents/$label.plist"
  cat > "$plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key>
  <array><string>/bin/bash</string><string>$script</string></array>
  <key>StartCalendarInterval</key>
  <dict><key>Hour</key><integer>$hour</integer><key>Minute</key><integer>$minute</integer></dict>
  <key>StandardOutPath</key><string>$state/logs/$label.out.log</string>
  <key>StandardErrorPath</key><string>$state/logs/$label.out.log</string>
</dict>
</plist>
PLIST
  launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$plist"
  echo "installed $label ($hour:$(printf %02d "$minute") daily) -> $script"
}
for job in "$@"; do
  case "$job" in
    sync) install_job com.example.t3code-fork.sync "$HOME/src/t3code-fork/fork/scripts/sync.sh" 5 0 ;;
    deploy)
      install -S -m 700 "$here/pull-deploy.sh" "$here/rollback.sh" "$state/"
      install_job com.example.t3code-fork.deploy "$state/pull-deploy.sh" 5 45 ;;
    watchdog)
      install -S -m 700 "$here/watchdog.sh" "$state/"
      plist="$HOME/Library/LaunchAgents/com.example.t3code-fork.watchdog.plist"
      cat > "$plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.example.t3code-fork.watchdog</string>
  <key>ProgramArguments</key>
  <array><string>/bin/bash</string><string>$state/watchdog.sh</string></array>
  <key>StartInterval</key><integer>60</integer>
  <key>StandardOutPath</key><string>$state/logs/watchdog.log</string>
  <key>StandardErrorPath</key><string>$state/logs/watchdog.log</string>
</dict>
</plist>
PLIST
      launchctl bootout "gui/$(id -u)/com.example.t3code-fork.watchdog" 2>/dev/null || true
      launchctl bootstrap "gui/$(id -u)" "$plist"
      echo "installed com.example.t3code-fork.watchdog (every 60 s) -> $state/watchdog.sh" ;;
    artifacts)
      # A static file server on localhost (plus the phone app's update manifest),
      # published to the tailnet only by Tailscale Serve (the macOS Tailscale app
      # cannot serve a directory itself).
      plist="$HOME/Library/LaunchAgents/com.example.t3code-fork.artifacts.plist"
      mkdir -p "$state/out"
      cp "$here/artifacts-server.py" "$state/"
      cat > "$plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.example.t3code-fork.artifacts</string>
  <key>ProgramArguments</key>
  <array><string>/usr/bin/python3</string><string>$state/artifacts-server.py</string>
    <string>8790</string><string>$state/out</string></array>
  <key>KeepAlive</key><true/>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>$state/logs/artifacts.log</string>
  <key>StandardErrorPath</key><string>$state/logs/artifacts.log</string>
</dict>
</plist>
PLIST
      launchctl bootout "gui/$(id -u)/com.example.t3code-fork.artifacts" 2>/dev/null || true
      launchctl bootstrap "gui/$(id -u)" "$plist"
      /Applications/Tailscale.app/Contents/MacOS/Tailscale serve --bg --https=8444 http://127.0.0.1:8790
      echo "installed com.example.t3code-fork.artifacts ($state/out on tailnet :8444)" ;;
    *) echo "unknown job $job" >&2; exit 1 ;;
  esac
done
