#!/bin/bash
# Install the fork's LaunchAgents on this Mac (idempotent). On Linux only deploy exists,
# as a systemd user timer and service of the same label.
#   fork/scripts/install-jobs.sh deploy        every Mac: daily pull of the newest release
#   fork/scripts/install-jobs.sh watchdog      every Mac: restart a hung T3 service (each
#                                              release's installer refreshes it)
#   fork/scripts/install-jobs.sh sync artifacts deploy
#                                              the build Mac: daily sync + build, and
#                                              its build outputs served to the tailnet on :8444
# Times are local: sync at 05:00, deploy at 05:45 (a missed run, e.g. while a
# laptop sleeps, runs at wake). Labels are <job_label_prefix>.<job> (fork.env).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
. "$here/fork.env" # job_label_prefix
state="$HOME/t3-fork"
mkdir -p "$state/logs"
if [ "$fork_platform" = linux-x64 ]; then
  units="$HOME/.config/systemd/user"
  mkdir -p "$units"
  for job in "$@"; do
    [ "$job" = deploy ] || { echo "$job is not available on Linux; only deploy is." >&2; exit 1; }
    label="$job_label_prefix.deploy"
    fork_install -m 600 "$here/fork.env" "$state/"
    fork_install -m 700 "$here/pull-deploy.sh" "$here/rollback.sh" "$state/"
    printf '%s\n' "[Unit]" "Description=Install the newest fork release" "" "[Service]" "Type=oneshot" \
      "ExecStart=/bin/bash $state/pull-deploy.sh" \
      "StandardOutput=append:$state/logs/$label.out.log" "StandardError=append:$state/logs/$label.out.log" > "$units/$label.service"
    # Persistent: a run missed while the machine was off runs at boot, as launchd does at wake.
    printf '%s\n' "[Unit]" "Description=Install the newest fork release daily" "" "[Timer]" \
      "OnCalendar=*-*-* 05:45:00" "Persistent=true" "" "[Install]" "WantedBy=timers.target" > "$units/$label.timer"
    systemctl --user daemon-reload
    systemctl --user enable --now "$label.timer"
    echo "installed $label (05:45 daily) -> $state/pull-deploy.sh"
  done
  exit 0
fi
mkdir -p "$HOME/Library/LaunchAgents"
launcher="$HOME/Applications/ExternalLauncher.app/Contents/MacOS/ExternalLauncher"
# load_job <label> <service>: installs the plist on stdin and (re)loads the job. On a Mac
# whose ~/t3-fork is a symlink onto a removable volume, only ExternalLauncher.app holds the
# macOS access grant: the job runs as `ExternalLauncher <service>`, which runs the same
# command and writes the same log on the volume, so launchd's own log and working directory
# stay on the internal disk. A job this Mac's launcher has no service for is refused rather
# than left failing every run. Where ~/t3-fork is a real directory (on the internal disk),
# the job runs its script directly even if the launcher is installed.
load_job() {
  local label=$1 service=$2 plist="$HOME/Library/LaunchAgents/$1.plist" new
  new=$(cat)
  if [ -x "$launcher" ] && [ -L "$state" ]; then
    new=$(/usr/bin/python3 -c '
import os, plistlib, sys
launcher, service, label = sys.argv[1:]
with open(launcher, "rb") as f:
    if b"\0" + service.encode() + b"\0" not in f.read():
        sys.exit(f"{launcher} has no {service} service; not installing {label}")
data = plistlib.loads(sys.stdin.buffer.read())
log = os.path.expanduser("~/Library/Logs/external-launcher/" + label + ".log")
os.makedirs(os.path.dirname(log), exist_ok=True)
data.update({"ProgramArguments": [launcher, service], "WorkingDirectory": os.path.dirname(log),
             "StandardOutPath": log, "StandardErrorPath": log})
sys.stdout.buffer.write(plistlib.dumps(data))
' "$launcher" "$service" "$label" <<< "$new")
  fi
  printf '%s\n' "$new" > "$plist"
  launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$plist"
}
install_job() {
  local label=$1 script=$2 hour=$3 minute=$4 service=$5
  load_job "$label" "$service" <<PLIST
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
  echo "installed $label ($hour:$(printf %02d "$minute") daily) -> $script"
}
for job in "$@"; do
  case "$job" in
    sync) install_job "$job_label_prefix.sync" "$HOME/src/t3code-fork/fork/scripts/sync.sh" 5 0 t3-sync ;;
    deploy)
      install -S -m 600 "$here/fork.env" "$state/"
      install -S -m 700 "$here/pull-deploy.sh" "$here/rollback.sh" "$state/"
      install_job "$job_label_prefix.deploy" "$state/pull-deploy.sh" 5 45 t3-deploy ;;
    watchdog)
      install -S -m 700 "$here/watchdog.sh" "$state/"
      load_job "$job_label_prefix.watchdog" t3-watchdog <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$job_label_prefix.watchdog</string>
  <key>ProgramArguments</key>
  <array><string>/bin/bash</string><string>$state/watchdog.sh</string></array>
  <key>StartInterval</key><integer>60</integer>
  <key>StandardOutPath</key><string>$state/logs/watchdog.log</string>
  <key>StandardErrorPath</key><string>$state/logs/watchdog.log</string>
</dict>
</plist>
PLIST
      echo "installed $job_label_prefix.watchdog (every 60 s) -> $state/watchdog.sh" ;;
    artifacts)
      # A static file server on localhost (plus the phone app's update manifest),
      # published to the tailnet only by Tailscale Serve (the macOS Tailscale app
      # cannot serve a directory itself).
      mkdir -p "$state/out"
      cp "$here/artifacts-server.py" "$state/"
      load_job "$job_label_prefix.artifacts" t3-artifacts <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$job_label_prefix.artifacts</string>
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
      /Applications/Tailscale.app/Contents/MacOS/Tailscale serve --bg --https=8444 http://127.0.0.1:8790
      echo "installed $job_label_prefix.artifacts ($state/out on tailnet :8444)" ;;
    *) echo "unknown job $job" >&2; exit 1 ;;
  esac
done
