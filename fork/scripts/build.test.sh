#!/bin/bash
# build.sh: a failure in the linux-x64 cross-build only leaves the Linux archive out, so the
# Macs' release still ships; a failure in the Macs' own build still fails the build.
#   fork/scripts/build.test.sh
# Runs the real script in a scratch repository; git, vp, node and cargo are stubbed as
# exported functions. Each build tool writes what its real counterpart would.
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
repo="$tmp/repo"
mkdir -p "$repo/fork/scripts" "$repo/apps/server" "$tmp/.config/julia"
cp "$here/fork.env" "$repo/fork/scripts/"
echo 'const SEA_NODE_VERSION = "24.0.0";' > "$repo/apps/server/vite.config.ts"
git() { [ "$1" = rev-parse ] && echo "$STUB_REPO"; return 0; }
vp() { :; }
# $STUB_FAIL names the step that fails: linux-cargo, linux-archive (after writing part of
# the archive) or mac-archive.
cargo() {
  local dir=native/resource-monitor/target/release
  case "$*" in *x86_64-unknown-linux-musl*)
    [ "$STUB_FAIL" = linux-cargo ] && return 1
    dir=native/resource-monitor/target/x86_64-unknown-linux-musl/release ;;
  esac
  mkdir -p "$dir" && touch "$dir/t3-resource-monitor"
}
node() {
  [ "$1" = scripts/build-cli-archive.ts ] || return 0
  local platform=$3 version=$7 out=${11}
  local archive="$out/t3-$version-$([ "$platform" = linux ] && echo linux-x64 || echo darwin-arm64).tar.gz"
  echo partial > "$archive"
  [ "$STUB_FAIL" = "$platform-archive" ] && return 1
  echo done > "$archive"
}
export -f git vp cargo node
export STUB_REPO="$repo"
status=0
fail() { echo "FAIL: $1"; printf 'output:\n%s\n' "$output"; status=1; }
run() {
  rm -rf "$tmp/out"
  output=$(cd "$repo" && HOME="$tmp" STUB_FAIL="$1" /bin/bash "$here/build.sh" 1.0.0+new "$tmp/out" 2>&1)
}
mac="$tmp/out/t3-1.0.0+new-darwin-arm64.tar.gz"
linux="$tmp/out/t3-1.0.0+new-linux-x64.tar.gz"

run none || fail "a clean build failed"
[ -f "$mac" ] && [ -f "$linux" ] && [ -f "$tmp/out/VERSION" ] || fail "a clean build did not write both archives"

for step in linux-cargo linux-archive; do
  run "$step" || fail "a failed Linux build ($step) failed the Macs' build"
  [ -f "$mac" ] && [ -f "$tmp/out/VERSION" ] || fail "a failed Linux build ($step) lost the Macs' archive"
  [ ! -e "$linux" ] || fail "a failed Linux build ($step) left a Linux archive"
  grep -q 'linux-x64 server build failed' <<<"$output" || fail "a failed Linux build ($step) was not reported"
done

run mac-archive && fail "a failed Macs' build did not fail the build"

[ "$status" = 0 ] && echo ok
exit "$status"
