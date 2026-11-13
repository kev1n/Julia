#!/bin/bash
# pull-deploy.sh finds the newest release, downloads and checks this machine's files, and
# hands the install to that release's deploy-when-idle.sh. A Mac asks GitHub (gh); a Linux
# machine, which holds no GitHub login, asks only the artifacts server.
#   fork/scripts/pull-deploy.test.sh
# Runs the real script against a scratch HOME; gh, curl and uname are stubbed as exported
# functions, which take precedence over the script's PATH.
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
tag=fork-1.0.0-abc1234
mkdir -p "$tmp/.t3/runtime" "$tmp/.config/julia" "$tmp/t3-fork" "$tmp/scripts" "$tmp/served/1.0.0+new"
printf '%s\n' fork_repo=example/julia build_mac_url=https://build.example > "$tmp/.config/julia/fork.env"
echo '{"activeVersion": "1.0.0+old"}' > "$tmp/.t3/runtime/service-state.json"
# The release's scripts: nothing is live, and deploy-when-idle.sh records what it was given.
printf '#!/bin/bash\nexit 0\n' > "$tmp/scripts/live-work.sh"
printf '#!/bin/bash\necho "$*" > "%s/scheduled"\n' "$tmp" > "$tmp/scripts/deploy-when-idle.sh"
chmod +x "$tmp/scripts/"*.sh
# The release as the build Mac publishes it (see deploy-when-idle.test.sh).
(cd "$tmp/served/1.0.0+new" && echo 1.0.0+new > VERSION && tar -czf fork-scripts.tar.gz -C "$tmp/scripts" . &&
  echo darwin > t3-1.0.0+new-darwin-arm64.tar.gz && echo linux > t3-1.0.0+new-linux-x64.tar.gz &&
  shasum -a 256 t3-*.tar.gz > SHA256SUMS)
echo "$tag 1.0.0+new" > "$tmp/served/latest-release"
gh() {
  printf '%s\n' "$*" >> "$STUB_TMP/gh.log"
  case "$1 $2" in
    "release list") echo "$STUB_TAG" ;;
    "release download") mkdir -p "${@: -1}" && cp "$STUB_TMP/served/1.0.0+new/"{VERSION,SHA256SUMS,fork-scripts.tar.gz} "${@: -1}" ;;
  esac
}
curl() {
  local args=("$@") i to=""
  for ((i = 0; i < ${#args[@]}; i++)); do [ "${args[i]}" = --output ] && to="${args[i + 1]}"; done
  local file="$STUB_TMP/served/${args[${#args[@]} - 1]#https://build.example:8444/}"
  if [ -n "$to" ]; then cp "$file" "$to"; else cat "$file"; fi
}
uname() { if [ -n "${STUB_UNAME:-}" ]; then echo "$STUB_UNAME"; else command uname "$@"; fi; }
export -f gh curl uname
export STUB_TAG="$tag" STUB_TMP="$tmp"
status=0
fail() { echo "FAIL: $1"; printf 'log:\n%s\n' "$(cat "$tmp/t3-fork/logs/deploy.log" 2>/dev/null)"; status=1; }
run() {
  rm -rf "$tmp/t3-fork/releases" "$tmp/t3-fork/logs" "$tmp/gh.log" "$tmp/scheduled"
  HOME="$tmp" /bin/bash "$here/pull-deploy.sh"
}
release="$tmp/t3-fork/releases/$tag"

# A Mac: the tag and VERSION, SHA256SUMS and scripts from GitHub, the darwin archive from the
# artifacts server.
run
grep -qx -- "--schedule $tag" "$tmp/scheduled" 2>/dev/null || fail "a Mac did not schedule the newest release"
grep -q "^release list -R example/julia" "$tmp/gh.log" && grep -q "^release download $tag -R example/julia" "$tmp/gh.log" ||
  fail "a Mac did not use the GitHub release"
[ -f "$release/t3-1.0.0+new-darwin-arm64.tar.gz" ] && [ ! -e "$release/t3-1.0.0+new-linux-x64.tar.gz" ] ||
  fail "a Mac did not download exactly its archive"

# Linux: everything from the artifacts server, and gh never runs.
STUB_UNAME=Linux run
grep -qx -- "--schedule $tag" "$tmp/scheduled" 2>/dev/null || fail "Linux did not schedule the newest release"
[ ! -e "$tmp/gh.log" ] || fail "Linux called gh: $(cat "$tmp/gh.log")"
[ -f "$release/t3-1.0.0+new-linux-x64.tar.gz" ] && [ -f "$release/fork-scripts.tar.gz" ] &&
  [ ! -e "$release/t3-1.0.0+new-darwin-arm64.tar.gz" ] || fail "Linux did not download exactly its release files"

# Linux, a corrupted transfer: nothing is kept or scheduled.
echo corrupt > "$tmp/served/1.0.0+new/t3-1.0.0+new-linux-x64.tar.gz"
STUB_UNAME=Linux run
[ ! -e "$tmp/scheduled" ] && [ ! -e "$release" ] || fail "Linux scheduled a release that failed its checksum"

[ "$status" = 0 ] && echo ok
exit "$status"
