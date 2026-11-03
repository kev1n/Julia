#!/bin/bash
# Put this Mac's T3 service back on another installed runtime (normally the
# stock nightly) and stop the daily fork deploy so it does not reinstall.
#   ~/t3-fork/rollback.sh 0.0.46-nightly.20261005.2702
# Undo: run fork/scripts/install-jobs.sh deploy from a fork checkout.
set -euo pipefail
version=${1:?runtime version under ~/.t3/runtime/versions}
state="$HOME/.t3/runtime/service-state.json"
[ -x "$HOME/.t3/runtime/versions/$version/t3" ] || { echo "Not installed: $version" >&2; exit 1; }
. "$(dirname "$0")/fork.env" # job_label_prefix
launchctl bootout "gui/$(id -u)/$job_label_prefix.deploy" 2>/dev/null || true
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
echo "Service switched to $version; fork deploy job stopped."
