#!/bin/bash
# sync.sh still opens or updates the "Fork sync failed" issue when its first fetch fails,
# before it has read the fork head it would reset to.
#   fork/scripts/sync.test.sh
# Runs a copy of the real script in a scratch repo whose origin does not exist, with a
# scratch HOME; gh is stubbed as an exported function and records its calls.
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/repo/fork/scripts" "$tmp/home/.config/julia"
install -S -m 755 "$here/sync.sh" "$tmp/repo/fork/scripts/sync.sh"
cp "$here/fork.env" "$tmp/repo/fork/scripts/"
printf 'fork_repo=example/fork\nartifacts_url=https://build.example\n' > "$tmp/home/.config/julia/fork.env"
git -C "$tmp/repo" init -q
git -C "$tmp/repo" remote add origin "$tmp/missing"
gh() { echo "gh $*" >> "$STUB_TMP/calls"; }
export -f gh
export STUB_TMP="$tmp"
status=0
fail() { echo "FAIL: $1"; printf 'output:\n%s\ncalls:\n%s\n' "$out" "$(cat "$tmp/calls" 2>/dev/null)"; status=1; }

out=$(HOME="$tmp/home" /bin/bash "$tmp/repo/fork/scripts/sync.sh" 2>&1)
case "$out" in *"unbound variable"*) fail "the failure path read an unset variable" ;; esac
grep -q '^gh issue \(create\|comment\)' "$tmp/calls" 2>/dev/null || fail "no issue was opened or updated"
exit $status
