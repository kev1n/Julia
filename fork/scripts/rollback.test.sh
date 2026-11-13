#!/bin/bash
# rollback.sh stops the daily deploy and every pending deploy-when-idle job before it switches
# the service, so neither reinstalls the release it rolled back from.
#   fork/scripts/rollback.test.sh
# Runs the real script against a scratch HOME; uname, systemctl and launchctl are stubbed as
# exported functions and record their calls.
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
prefix=org.example.fork
label=$prefix.deploy-when-idle-abc1234
mkdir -p "$tmp/.config/julia" "$tmp/t3-fork" "$tmp/.t3/runtime/versions/1.0.0+old"
echo "job_label_prefix=$prefix" > "$tmp/.config/julia/fork.env"
printf '#!/bin/bash\necho "t3 $*" >> "%s/calls"\n' "$tmp" > "$tmp/.t3/runtime/versions/1.0.0+old/t3"
chmod +x "$tmp/.t3/runtime/versions/1.0.0+old/t3"
uname() { if [ -n "${STUB_UNAME:-}" ]; then echo "$STUB_UNAME"; else command uname "$@"; fi; }
systemctl() { echo "systemctl $*" >> "$STUB_TMP/calls"; }
launchctl() { echo "launchctl $*" >> "$STUB_TMP/calls"; }
export -f uname systemctl launchctl
export STUB_TMP="$tmp"
status=0
fail() { echo "FAIL: $1"; printf 'calls:\n%s\n' "$(cat "$tmp/calls" 2>/dev/null)"; status=1; }

# Linux: a pending install's timer and service are stopped and retired, like the daily job,
# before the service is switched.
units="$tmp/.config/systemd/user"
mkdir -p "$units"
touch "$units/$label.timer" "$units/$label.service"
rm -f "$tmp/calls"
STUB_UNAME=Linux HOME="$tmp" /bin/bash "$here/rollback.sh" 1.0.0+old > /dev/null || fail "Linux rollback failed"
grep -qx "systemctl --user disable --now $prefix.deploy.timer" "$tmp/calls" &&
  grep -qx "systemctl --user stop $prefix.deploy.service" "$tmp/calls" || fail "Linux did not stop the daily deploy"
grep -qx "systemctl --user disable --now $label.timer" "$tmp/calls" &&
  grep -qx "systemctl --user stop $label.service" "$tmp/calls" || fail "Linux did not stop the pending install"
[ ! -e "$units/$label.timer" ] && [ ! -e "$units/$label.service" ] && [ -f "$tmp/t3-fork/$label.completed.timer" ] ||
  fail "Linux left the pending install's units in place"
[ "$(grep -n . "$tmp/calls" | grep 't3 service install' | cut -d: -f1)" = "$(wc -l < "$tmp/calls" | tr -d ' ')" ] ||
  fail "Linux switched the service before stopping the jobs"

# macOS: a pending install's LaunchAgent is booted out and retired too.
mkdir -p "$tmp/Library/LaunchAgents"
touch "$tmp/Library/LaunchAgents/$label.plist"
echo '{"protocol": 1, "activeVersion": "1.0.0+new"}' > "$tmp/.t3/runtime/service-state.json"
rm -f "$tmp/calls"
STUB_UNAME=Darwin HOME="$tmp" /bin/bash "$here/rollback.sh" 1.0.0+old > /dev/null || fail "macOS rollback failed"
grep -q "^launchctl bootout gui/[0-9]*/$label$" "$tmp/calls" || fail "macOS did not boot out the pending install"
[ ! -e "$tmp/Library/LaunchAgents/$label.plist" ] && [ -f "$tmp/t3-fork/$label.completed.plist" ] ||
  fail "macOS left the pending install's LaunchAgent in place"

[ "$status" = 0 ] && echo ok
exit "$status"
