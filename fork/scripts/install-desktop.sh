#!/bin/bash
# Install Julia.app from a build's zip into /Applications.
#   fork/scripts/install-desktop.sh <T3-Code-*-arm64.zip>
# A running copy keeps running from its old files and picks up the new
# version on its next launch; this never quits the app.
set -euo pipefail
zip=${1:?zip}
stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
/usr/bin/ditto -x -k "$zip" "$stage"
app="$stage/Julia.app"
[ -d "$app" ] || { echo "No Julia.app in $zip" >&2; exit 1; }
destination="/Applications/Julia.app"
legacy="/Applications/T3 Code (Owner).app"
fork_bundle_id=com.example.julia
for installed in "$app" "$destination" "$legacy"; do
  [ -d "$installed" ] || continue
  bundle_id=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$installed/Contents/Info.plist")
  [ "$bundle_id" = "$fork_bundle_id" ] || { echo "Refusing to replace another app at $installed" >&2; exit 1; }
done
# Unsigned local build: clear the download quarantine so Gatekeeper opens it.
/usr/bin/xattr -dr com.apple.quarantine "$app" 2>/dev/null || true
rm -rf "$destination.previous"
[ -d "$destination" ] && mv "$destination" "$destination.previous"
/usr/bin/ditto "$app" "$destination"
rm -rf "$destination.previous"
if [ -d "$legacy" ]; then
  # Keep the old bundle out of Applications/Spotlight without discarding rollback files.
  backup="$HOME/t3-fork/desktop-backups/$(date +%Y%m%d-%H%M%S)"
  mkdir -p "$backup"
  mv "$legacy" "$backup/"
fi
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$destination"
# Preserve the existing Dock pin's position, but discard its bookmark to the old bundle.
dock_snapshot="$stage/dock.plist"
if defaults export com.apple.dock "$dock_snapshot" >/dev/null 2>&1; then
  if /usr/bin/python3 - "$dock_snapshot" <<'PY'
import plistlib, sys
path = sys.argv[1]
with open(path, "rb") as f:
    dock = plistlib.load(f)
changed = False
for entry in dock.get("persistent-apps", []):
    tile = entry.get("tile-data", {})
    if tile.get("bundle-identifier") != "com.example.julia":
        continue
    if tile.get("file-label") == "Julia" and tile.get("file-data", {}).get("_CFURLString") == "file:///Applications/Julia.app/":
        continue
    tile["file-label"] = "Julia"
    tile["file-data"] = {"_CFURLString": "file:///Applications/Julia.app/", "_CFURLStringType": 15}
    tile.pop("book", None)
    changed = True
if not changed:
    sys.exit(1)
with open(path, "wb") as f:
    plistlib.dump(dock, f)
PY
  then
    defaults import com.apple.dock "$dock_snapshot" >/dev/null
    launchctl kickstart -k "gui/$(id -u)/com.apple.Dock.agent" || true
  fi
fi
# The app keeps its own state in ~/.t3-owner-app (apps/desktop/src/fork/profile.ts).
# This Mac's server is the LaunchAgent service, so the app must never start its
# own local backend: seed that preference before the first launch.
settings="$HOME/.t3-owner-app/userdata/desktop-settings.json"
if [ ! -f "$settings" ]; then
  mkdir -p "$(dirname "$settings")"
  printf '{"localEnvironmentEnabled":false}\n' > "$settings"
fi
echo "Installed $destination $(/usr/bin/defaults read "$destination/Contents/Info" CFBundleShortVersionString)"
