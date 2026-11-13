#!/bin/bash
# latest-release.sh names a published release for the Linux machines only when that release
# has a linux-x64 archive, and takes the version from the GitHub release when not given one.
#   fork/scripts/latest-release.test.sh
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/.config/julia" "$tmp/t3-fork/out/1.0.0+new" "$tmp/t3-fork/out/1.0.0+mac"
echo fork_repo=example/julia > "$tmp/.config/julia/fork.env"
touch "$tmp/t3-fork/out/1.0.0+new/t3-1.0.0+new-linux-x64.tar.gz"
# The GitHub release's VERSION.
gh() { [ "$*" = "release download fork-1.0.0-new -R example/julia -p VERSION -O -" ] && echo 1.0.0+new; }
export -f gh
file="$tmp/t3-fork/out/latest-release"
status=0
fail() { echo "FAIL: $1"; status=1; }
run() { HOME="$tmp" /bin/bash "$here/latest-release.sh" "$@" > /dev/null; }

run fork-1.0.0-new 1.0.0+new || fail "failed with a version"
[ "$(cat "$file" 2>/dev/null)" = "fork-1.0.0-new 1.0.0+new" ] || fail "did not name the published release"

# A release already published (a rerun): the version comes from GitHub.
rm -f "$file"
run fork-1.0.0-new || fail "failed without a version"
[ "$(cat "$file" 2>/dev/null)" = "fork-1.0.0-new 1.0.0+new" ] || fail "did not catch up from the GitHub release's VERSION"

# A release whose Linux build failed leaves the Linux machines on the last one they had.
run fork-1.0.0-mac 1.0.0+mac || fail "failed for a release without a Linux archive"
[ "$(cat "$file" 2>/dev/null)" = "fork-1.0.0-new 1.0.0+new" ] || fail "named a release without a Linux archive"

[ "$status" = 0 ] && echo ok
exit "$status"
