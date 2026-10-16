#!/bin/bash
# A live-work.sh that fails (SQLite busy, say) and prints nothing must read as
# "not idle": deploy-when-idle.sh logs the failure and does not install.
#   fork/scripts/deploy-when-idle.test.sh
# Runs the real script against a scratch HOME; gh and curl are stubbed as
# exported functions, which take precedence over the script's fixed PATH.
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
tag=owner-1.0.0-abc1234
dir="$tmp/t3-fork/releases/$tag"
mkdir -p "$dir/scripts" "$tmp/.t3/runtime"
echo 1.0.0+new > "$dir/VERSION"
echo '{"activeVersion": "1.0.0+old"}' > "$tmp/.t3/runtime/service-state.json"
touch "$tmp/t3-fork/desktop-local-build"
printf '#!/bin/bash\nexit 3\n' > "$dir/scripts/live-work.sh"
printf '#!/bin/bash\ntouch "%s/installed"\n' "$tmp" > "$dir/scripts/install-runtime.sh"
chmod +x "$dir/scripts/"*.sh
gh() { echo "$STUB_TAG"; }
curl() { echo '{"serverVersion": "1.0.0+old"}'; }
export -f gh curl
export STUB_TAG="$tag"
out=$(HOME="$tmp" /bin/bash "$here/deploy-when-idle.sh" "$tag" 2>&1)
status=0
[ ! -e "$tmp/installed" ] || { echo "FAIL: installed while live-work.sh failed"; status=1; }
grep -q 'live-work.sh failed (exit 3)' <<<"$out" || { echo "FAIL: no log of the failed live-work check"; status=1; }
[ "$status" = 0 ] && echo ok || printf 'output:\n%s\n' "$out"
exit "$status"
