#!/bin/bash
# Install a fork server runtime on this machine and switch the running service to it.
#   fork/scripts/install-runtime.sh <t3-<version>-<darwin-arm64|linux-x64>.tar.gz>
#
# The LaunchAgent (com.t3tools.t3code.service) stays as `t3 service install`
# wrote it: it runs the stock runtime's version-agnostic `__service-launcher`,
# which starts `runtime/versions/<activeVersion>/t3 serve`. Switching versions
# is therefore only the state file plus a restart. Keeping the launcher's path
# keeps the macOS privacy grants (Full Disk Access) that are tied to it.
# Rollback: the same switch back to the stock version (see FORK.md).
#
# Linux: the systemd user unit (t3code.service) that `t3 service install` writes starts the
# launcher of the runtime it was installed from, and there is no stock runtime to keep. So the
# switch is the new runtime's own `t3 service install`, which writes the state file and the
# unit and restarts it; on a machine without the service yet, that installs it.
set -euo pipefail
archive=${1:?archive}
. "$(dirname "$0")/fork.env" # version_label, fork_platform
home=${T3CODE_HOME:-$HOME/.t3}
versions="$home/runtime/versions"
state="$home/runtime/service-state.json"
label="com.t3tools.t3code.service"
name=$(basename "$archive" .tar.gz)
version=${name#t3-}
version=${version%-"$fork_platform"}
dest="$versions/$version"
mkdir -p "$versions"

if [ ! -f "$dest/.install-complete" ]; then
  stage=$(mktemp -d "$versions/.fork-stage.XXXXXX")
  tar -xzf "$archive" -C "$stage"
  "$stage/$name/t3" --version | grep -qx "t3 v$version"
  printf '%s\n' "$version" > "$stage/$name/.install-complete"
  chmod 700 "$stage/$name"
  rm -rf "$dest"
  mv "$stage/$name" "$dest"
  rm -rf "$stage"
fi

read_active() {
  /usr/bin/python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(d["activeVersion"]); sys.exit(1 if "update" in d and d["update"].get("status")=="pending" else 0)' "$state"
}
if [ "$fork_platform" = linux-x64 ] && [ ! -f "$state" ]; then
  previous="" # the first install on this machine
else
  previous=$(read_active) || { echo "A service update is pending; not switching." >&2; exit 1; }
fi

switch_to() {
  if [ "$fork_platform" = linux-x64 ]; then
    # This script picks the version, a rollback to the previous one included. A failure
    # shows as the server not coming up on it, which wait_for below handles.
    "$versions/$1/t3" service install --base-dir "$home" --allow-downgrade ||
      echo "t3 service install failed for $1." >&2
    return 0
  fi
  /usr/bin/python3 - "$state" "$1" <<'PY'
import json, os, sys
path, version = sys.argv[1], sys.argv[2]
with open(path) as f:
    current = json.load(f)
tmp = path + ".fork-tmp"
with open(tmp, "w") as f:
    json.dump({"protocol": current["protocol"], "activeVersion": version}, f, indent=2)
    f.write("\n")
    f.flush()
    os.fsync(f.fileno())
os.replace(tmp, path)
PY
  launchctl kickstart -k "gui/$(id -u)/$label"
}

# The launcher gives a starting server 120 s to report ready
# (PREPARED_TIMEOUT_MS in apps/server/src/serviceLauncher.ts); wait as long.
wait_for() {
  local deadline=$((SECONDS + 120))
  while [ $SECONDS -lt $deadline ]; do
    reported=$(curl -s --max-time 5 http://127.0.0.1:3773/.well-known/t3/environment |
      /usr/bin/python3 -c 'import json,sys; print(json.load(sys.stdin).get("serverVersion",""))' 2>/dev/null || true)
    [ "$reported" = "$1" ] && return 0
    /bin/sleep 2
  done
  return 1
}

# Once per machine: switch the state database to incremental vacuum, so the
# history of settled threads moved to a history store (FORK.md, "Settled
# threads offloaded") gives its disk back as it leaves. VACUUM needs the server
# stopped and, per SQLite's documentation, up to twice the file's size free; 42 s
# for a 2.8 GB database on 2026-10-14. Without the room it is left for a later deploy.
# Not on Linux: those machines' databases were created incremental (persistence/Sqlite.ts).
db="$home/userdata/statev2.sqlite"
if [ "$fork_platform" = darwin-arm64 ] && [ -f "$db" ] && [ "$(/usr/bin/sqlite3 -readonly "$db" 'PRAGMA auto_vacuum')" != 2 ]; then
  if [ "$(df -k "$db" | awk 'NR == 2 { print $4 }')" -gt $(($(stat -f %z "$db") * 2 / 1024)) ]; then
    launchctl bootout "gui/$(id -u)/$label" || true
    /usr/bin/sqlite3 "$db" 'PRAGMA auto_vacuum = INCREMENTAL; VACUUM;' ||
      echo "Could not compact $db; it stays as it was." >&2
    launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/$label.plist" || true
  else
    echo "Not enough free disk to compact $db; leaving it for a later deploy." >&2
  fi
fi

if [ "$previous" != "$version" ]; then
  switch_to "$version"
fi
if ! wait_for "$version"; then
  [ -n "$previous" ] || { echo "Server did not come up on $version." >&2; exit 1; }
  echo "Server did not come up on $version; switching back to $previous." >&2
  switch_to "$previous"
  wait_for "$previous" || true
  exit 1
fi
echo "Service runs $version (was $previous)."

# The daily job runs ~/t3-fork/pull-deploy.sh; keep its idle check in step with
# the release just installed (install-desktop.sh does this only where the app is).
# That job is usually the caller: install -S puts a new file in place, so the
# running bash keeps reading the old one (replace-running-scripts.test.sh).
here=$(cd "$(dirname "$0")" && pwd)
if [ -d "$HOME/t3-fork" ] && [ -f "$here/pull-deploy.sh" ]; then
  fork_install -m 600 "$here/fork.env" "$HOME/t3-fork/fork.env"
  fork_install -m 700 "$here/pull-deploy.sh" "$HOME/t3-fork/pull-deploy.sh"
fi
# Same for the watchdog that restarts a hung service; this also installs it on
# a Mac that does not have it yet. Not on Linux, where it is not ported (FORK.md).
if [ "$fork_platform" = darwin-arm64 ] && [ -d "$HOME/t3-fork" ] && [ -f "$here/watchdog.sh" ]; then
  "$here/install-jobs.sh" watchdog || echo "Could not install the watchdog." >&2
fi

# Keep the stock runtimes, the active fork runtime, and the one before it for rollback.
for dir in "$versions"/*+"$version_label".*; do
  [ -d "$dir" ] || continue
  v=$(basename "$dir")
  [ "$v" = "$version" ] || [ "$v" = "$previous" ] || rm -rf "$dir"
done
