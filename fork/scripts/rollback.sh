#!/bin/bash
# Put this machine's T3 service back on another installed runtime (normally the
# stock nightly on a Mac, the previous fork runtime on Linux) and stop the daily fork
# deploy and every pending deploy-when-idle job, so nothing reinstalls.
#   ~/t3-fork/rollback.sh 0.0.46-nightly.20261005.2702
# Undo: run fork/scripts/install-jobs.sh deploy from a fork checkout.
set -euo pipefail
version=${1:?runtime version under ~/.t3/runtime/versions}
state="$HOME/.t3/runtime/service-state.json"
[ -x "$HOME/.t3/runtime/versions/$version/t3" ] || { echo "Not installed: $version" >&2; exit 1; }
. "$(dirname "$0")/fork.env" # job_label_prefix, fork_platform
jobs="$HOME/t3-fork"
if [ "$fork_platform" = linux-x64 ]; then
  units="$HOME/.config/systemd/user"
  # The daily job first (a run in progress too), so it cannot schedule another install.
  systemctl --user disable --now "$job_label_prefix.deploy.timer" 2>/dev/null || true
  systemctl --user stop "$job_label_prefix.deploy.service" 2>/dev/null || true
  for timer in "$units/$job_label_prefix".deploy-when-idle-*.timer; do
    [ -e "$timer" ] || continue
    label=$(basename "$timer" .timer)
    systemctl --user disable --now "$label.timer" 2>/dev/null || true
    systemctl --user stop "$label.service" 2>/dev/null || true
    mv "$timer" "$jobs/$label.completed.timer"
    mv "$units/$label.service" "$jobs/$label.completed.service"
  done
  systemctl --user daemon-reload 2>/dev/null || true
  "$HOME/.t3/runtime/versions/$version/t3" service install --allow-downgrade
  echo "Service switched to $version; fork deploy jobs stopped."
  exit 0
fi
launchctl bootout "gui/$(id -u)/$job_label_prefix.deploy" 2>/dev/null || true
for plist in "$HOME/Library/LaunchAgents/$job_label_prefix".deploy-when-idle-*.plist; do
  [ -e "$plist" ] || continue
  label=$(basename "$plist" .plist)
  launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
  mv "$plist" "$jobs/$label.completed.plist"
done
/usr/bin/python3 - "$state" "$version" <<'PY'
import json, os, sys
path, version = sys.argv[1], sys.argv[2]
current = json.load(open(path))
tmp = path + ".fork-tmp"
with open(tmp, "w") as f:
    json.dump({"protocol": current["protocol"], "activeVersion": version}, f, indent=2)
    f.write("\n")
os.replace(tmp, path)
PY
launchctl kickstart -k "gui/$(id -u)/com.t3tools.t3code.service"
echo "Service switched to $version; fork deploy jobs stopped."
