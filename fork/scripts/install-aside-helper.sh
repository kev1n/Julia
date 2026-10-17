#!/bin/bash
# Runs Aside under aside-cdp-helper.mjs, so T3's "Aside" browser profile can stream and
# drive real Aside tabs over a private socket. Replaces the LaunchAgent that opens Aside
# at login. Quitting Aside here relocks 1Password on the minis until it is unlocked again.
#
#   install-aside-helper.sh              install or update, then (re)start Aside under it
#   install-aside-helper.sh --uninstall  back to the normal Aside launch
set -euo pipefail

label=com.example.t3code-fork.aside-helper
plist="$HOME/Library/LaunchAgents/$label.plist"
. "$(dirname "$0")/fork.env" # aside_login_label
normal_label=$aside_login_label
normal_plist="$HOME/Library/LaunchAgents/$normal_label.plist"
home="$HOME/t3-fork/aside"
domain="gui/$(id -u)"

quit_aside() {
  pgrep -qf '^/Applications/Aside.app/Contents/MacOS/Aside( |$)' || return 0
  osascript -e 'quit app "Aside"' >/dev/null 2>&1 || true
  for _ in $(seq 1 30); do
    pgrep -qf '^/Applications/Aside.app/Contents/MacOS/Aside( |$)' || return 0
    sleep 1
  done
  echo "Aside did not quit; quit it yourself and run this again." >&2
  exit 1
}

if [ "${1:-}" = --uninstall ]; then
  launchctl bootout "$domain/$label" 2>/dev/null || true
  rm -f "$plist"
  quit_aside
  if [ -f "$normal_plist.disabled" ]; then
    mv "$normal_plist.disabled" "$normal_plist"
    launchctl bootstrap "$domain" "$normal_plist" 2>/dev/null || true
  fi
  open -g -a /Applications/Aside.app
  echo "Aside runs normally again."
  exit 0
fi

# launchd has no shell PATH, so resolve a real node binary (not a version-manager shim).
node_bin=$(asdf which node 2>/dev/null || command -v node || true)
[ -x "$node_bin" ] || { echo "No node binary found." >&2; exit 1; }
mkdir -p "$home" "$HOME/t3-fork/logs"
cp "$(dirname "$0")/aside-cdp-helper.mjs" "$home/aside-cdp-helper.mjs"

launchctl bootout "$domain/$label" 2>/dev/null || true
if [ -f "$normal_plist" ]; then
  launchctl bootout "$domain/$normal_label" 2>/dev/null || true
  mv "$normal_plist" "$normal_plist.disabled"
fi
quit_aside

/usr/bin/python3 - "$plist" "$label" "$node_bin" "$home" <<'PY'
import os, plistlib, sys
path, label, node, home = sys.argv[1:]
log = os.path.expanduser("~/t3-fork/logs/aside-helper.log")
plistlib.dump({
    "Label": label,
    "ProgramArguments": [node, os.path.join(home, "aside-cdp-helper.mjs")],
    "RunAtLoad": True,
    # Restart after a crash, not after Aside was quit on purpose.
    "KeepAlive": {"SuccessfulExit": False},
    "ProcessType": "Interactive",
    "StandardOutPath": log,
    "StandardErrorPath": log,
}, open(path, "wb"))
os.chmod(path, 0o600)
PY
rm -f "$HOME/.t3-aside/cdp.sock"
launchctl bootstrap "$domain" "$plist"
for _ in $(seq 1 20); do
  [ -S "$HOME/.t3-aside/cdp.sock" ] && { echo "Aside runs under the T3 helper. Unlock 1Password in it if it asks."; exit 0; }
  sleep 1
done
echo "The helper did not start; see ~/t3-fork/logs/aside-helper.log." >&2
exit 1
