#!/bin/bash
# Install "T3 Code (Owner).app" from a build's zip into /Applications.
#   fork/scripts/install-desktop.sh <T3-Code-*-arm64.zip>
# A running copy keeps running from its old files and picks up the new
# version on its next launch; this never quits the app.
set -euo pipefail
zip=${1:?zip}
stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
/usr/bin/ditto -x -k "$zip" "$stage"
app="$stage/T3 Code (Owner).app"
[ -d "$app" ] || { echo "No T3 Code (Owner).app in $zip" >&2; exit 1; }
# Unsigned local build: clear the download quarantine so Gatekeeper opens it.
/usr/bin/xattr -dr com.apple.quarantine "$app" 2>/dev/null || true
rm -rf "/Applications/T3 Code (Owner).app.previous"
[ -d "/Applications/T3 Code (Owner).app" ] &&
  mv "/Applications/T3 Code (Owner).app" "/Applications/T3 Code (Owner).app.previous"
/usr/bin/ditto "$app" "/Applications/T3 Code (Owner).app"
rm -rf "/Applications/T3 Code (Owner).app.previous"
# The app keeps its own state in ~/.t3-owner-app (apps/desktop/src/fork/profile.ts).
# This Mac's server is the LaunchAgent service, so the app must never start its
# own local backend: seed that preference before the first launch.
settings="$HOME/.t3-owner-app/userdata/desktop-settings.json"
if [ ! -f "$settings" ]; then
  mkdir -p "$(dirname "$settings")"
  printf '{"localEnvironmentEnabled":false}\n' > "$settings"
fi
echo "Installed /Applications/T3 Code (Owner).app $(/usr/bin/defaults read "/Applications/T3 Code (Owner).app/Contents/Info" CFBundleShortVersionString)"
