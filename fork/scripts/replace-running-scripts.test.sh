#!/bin/bash
# bash reads a script while it runs it, so copying over a running script (cp
# keeps the file) makes the running bash execute the new bytes from its old
# offset; on 2026-10-14 that crashed ~/t3-fork/pull-deploy.sh mid-deploy.
# Scripts a deploy job may be running must be replaced with a new file instead:
# `install -S` writes a temporary file and renames it over the old one.
#   fork/scripts/replace-running-scripts.test.sh
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
status=0

# A script that replaces itself with install -S keeps running its own bytes.
printf '#!/bin/bash\ninstall -S -m 700 "$1" "$0"\necho kept\n' > "$tmp/run.sh"
printf '#!/bin/bash\necho replaced\n# a longer file than the one it replaces\n' > "$tmp/next.sh"
[ "$(bash "$tmp/run.sh" "$tmp/next.sh")" = kept ] || { echo "FAIL: install -S disturbed a running script"; status=1; }

# No fork script copies a shell script with cp.
if grep -nE '^[[:space:]]*cp .*\.sh"( "[^"]*")*$' "$here"/*.sh; then
  echo "FAIL: the lines above cp a script over one a deploy job may be running; use install -S"
  status=1
fi
[ "$status" = 0 ] && echo ok
exit "$status"
