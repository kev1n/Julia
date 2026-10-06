#!/bin/bash
# Install a fork server runtime on this Mac and switch the running service to it.
#   fork/scripts/install-runtime.sh <t3-<version>-darwin-arm64.tar.gz>
#
# The LaunchAgent (com.t3tools.t3code.service) stays as `t3 service install`
# wrote it: it runs the stock runtime's version-agnostic `__service-launcher`,
# which starts `runtime/versions/<activeVersion>/t3 serve`. Switching versions
# is therefore only the state file plus a restart. Keeping the launcher's path
# keeps the macOS privacy grants (Full Disk Access) that are tied to it.
# Rollback: the same switch back to the stock version (see FORK.md).
set -euo pipefail
archive=${1:?archive}
home=${T3CODE_HOME:-$HOME/.t3}
versions="$home/runtime/versions"
state="$home/runtime/service-state.json"
label="com.t3tools.t3code.service"
name=$(basename "$archive" .tar.gz)
version=${name#t3-}
version=${version%-darwin-arm64}
dest="$versions/$version"

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
previous=$(read_active) || { echo "A service update is pending; not switching." >&2; exit 1; }

switch_to() {
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

if [ "$previous" != "$version" ]; then
  switch_to "$version"
fi
if ! wait_for "$version"; then
  echo "Server did not come up on $version; switching back to $previous." >&2
  switch_to "$previous"
  wait_for "$previous" || true
  exit 1
fi
echo "Service runs $version (was $previous)."

# Keep the stock runtimes, the active fork runtime, and the one before it for rollback.
for dir in "$versions"/*+owner.*; do
  [ -d "$dir" ] || continue
  v=$(basename "$dir")
  [ "$v" = "$version" ] || [ "$v" = "$previous" ] || rm -rf "$dir"
done
