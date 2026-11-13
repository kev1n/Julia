#!/bin/bash
# deploy-when-idle.sh waits, without draining, while the server reports live work;
# only once it is idle does it start the drain, installing if the drain is idle too
# and cancelling it otherwise (or installs at once with --now). On a server without
# the drain it falls back to live-work.sh, failing closed.
#   fork/scripts/deploy-when-idle.test.sh
# Runs the real script against a scratch HOME; gh, curl and launchctl are stubbed
# as exported functions, which take precedence over the script's fixed PATH.
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
tag=fork-1.0.0-abc1234
dir="$tmp/t3-fork/releases/$tag"
mkdir -p "$dir/scripts" "$tmp/.t3/runtime" "$tmp/.t3/userdata" "$tmp/.config/julia"
# The repository, hosts and labels come from the local config that fork.env reads.
printf '%s\n' fork_repo=example/julia build_mac_url=https://build.example job_label_prefix=org.example.fork \
  > "$tmp/.config/julia/fork.env"
echo 1.0.0+new > "$dir/VERSION"
echo '{"activeVersion": "1.0.0+old"}' > "$tmp/.t3/runtime/service-state.json"
echo '{"secret": "fleet-secret"}' > "$tmp/.t3/userdata/fork-fleet.json"
touch "$tmp/t3-fork/desktop-local-build"
printf '#!/bin/bash\necho "$1" > "%s/installed"\n' "$tmp" > "$dir/scripts/install-runtime.sh"
chmod +x "$dir/scripts/install-runtime.sh"
# live-work.sh, exiting with $1 after printing nothing (the old "idle").
live_work() {
  printf '#!/bin/bash\nexit %s\n' "$1" > "$dir/scripts/live-work.sh"
  chmod +x "$dir/scripts/live-work.sh"
}
# The release as the build Mac publishes it: on GitHub (VERSION, SHA256SUMS, scripts) and on
# the artifacts server ($served, at build.example:8444), which also has both archives and
# latest-release. gh records each call; a release download copies the GitHub files.
served="$tmp/served"
mkdir -p "$served/1.0.0+new" "$tmp/scripts"
install -m 700 "$dir/scripts/install-runtime.sh" "$tmp/scripts/"
printf '#!/bin/bash\nexit 0\n' > "$tmp/scripts/live-work.sh"
chmod +x "$tmp/scripts/live-work.sh"
(cd "$served/1.0.0+new" && echo 1.0.0+new > VERSION && tar -czf fork-scripts.tar.gz -C "$tmp/scripts" . &&
  echo darwin > t3-1.0.0+new-darwin-arm64.tar.gz && echo linux > t3-1.0.0+new-linux-x64.tar.gz &&
  shasum -a 256 t3-*.tar.gz > SHA256SUMS)
echo "$tag 1.0.0+new" > "$served/latest-release"
gh() {
  printf '%s\n' "$*" >> "$STUB_LOG.gh"
  case "$1 $2" in
    "release download") cp "$STUB_SERVED/1.0.0+new/"{VERSION,SHA256SUMS,fork-scripts.tar.gz} "${@: -1}" ;;
    *) echo "$STUB_TAG" ;;
  esac
}
# The drain answers a peek with $STUB_PEEK, a start with $STUB_START (default: the
# peek's answer), with HTTP $STUB_DRAIN_CODE, and records each request.
curl() {
  case "$*" in
    *--output*)
      local args=("$@") i
      for ((i = 0; i < ${#args[@]}; i++)); do [ "${args[i]}" = --output ] && local to="${args[i + 1]}"; done
      cp "$STUB_SERVED/${args[${#args[@]} - 1]#https://build.example:8444/}" "$to"
      ;;
    *build.example:8444/latest-release*) cat "$STUB_SERVED/latest-release" ;;
    *'"action": "start"'*)
      { cat; printf '%s\n' "$*"; } >> "$STUB_LOG"
      printf '%s\n%s' "${STUB_START:-$STUB_PEEK}" "$STUB_DRAIN_CODE"
      ;;
    *fork/fleet/drain*)
      { cat; printf '%s\n' "$*"; } >> "$STUB_LOG"
      printf '%s\n%s' "$STUB_PEEK" "$STUB_DRAIN_CODE"
      ;;
    *) echo '{"serverVersion": "1.0.0+old"}' ;;
  esac
}
launchctl() { :; }
# uname answers $STUB_UNAME when set, so a run can take the Linux path; systemctl records.
uname() { if [ -n "${STUB_UNAME:-}" ]; then echo "$STUB_UNAME"; else command uname "$@"; fi; }
systemctl() { printf '%s\n' "$*" >> "$STUB_LOG.systemctl"; }
export -f gh curl launchctl uname systemctl
export STUB_TAG="$tag" STUB_LOG="$tmp/drain-requests" STUB_SERVED="$served"
status=0
fail() { echo "FAIL: $1"; printf 'output:\n%s\n' "$out"; status=1; }
run() {
  rm -f "$tmp/installed" "$STUB_LOG" "$STUB_LOG.gh"
  out=$(HOME="$tmp" /bin/bash "$here/deploy-when-idle.sh" "$@" 2>&1)
}
waiting='{"idle": false, "waitingFor": [{"kind": "subagent", "title": "Audit", "what": "review"}], "notWaitingFor": []}'
drained='{"idle": true, "waitingFor": [], "notWaitingFor": [{"kind": "monitor", "title": "Deploys", "what": "watch install"}]}'

# Work is live: wait without draining (new work is still taken), and do not install,
# even though live-work.sh would call it idle.
live_work 0
STUB_PEEK="$waiting" STUB_DRAIN_CODE=200 run "$tag" --requester claude-session-1
[ ! -e "$tmp/installed" ] || fail "installed while work is live"
grep -q '"action": "start"' "$STUB_LOG" && fail "started the drain while work is live"
grep -q 'Waiting for 1 live item' <<<"$out" || fail "no log of what it waits for"
grep -q '"action": "peek", "release": "fork-1.0.0-abc1234", "requester": "claude-session-1"' "$STUB_LOG" ||
  fail "the request did not carry the release and the requesting session"
grep -q 'Authorization: Bearer fleet-secret' "$STUB_LOG" || fail "the request was not authorized"

# Idle, and the drain is idle too: install, logging the requester's work it left out.
STUB_PEEK="$drained" STUB_DRAIN_CODE=200 run "$tag" --requester claude-session-1
grep -qx "$dir/t3-1.0.0+new-darwin-arm64.tar.gz" "$tmp/installed" 2>/dev/null || fail "did not install the darwin-arm64 archive once drained"
grep -q '"action": "start"' "$STUB_LOG" || fail "installed without starting the drain"
grep -q 'Not waiting for the thread that scheduled this deploy: monitor Deploys' <<<"$out" ||
  fail "no log of the requester's work left out"

# Idle, but work began before the drain took hold: cancel it at once, no install.
STUB_PEEK="$drained" STUB_START="$waiting" STUB_DRAIN_CODE=200 run "$tag"
[ ! -e "$tmp/installed" ] || fail "installed although the drain found work"
grep -q '"action": "cancel"' "$STUB_LOG" || fail "left the drain on after it found work"

# A drain answer that cannot be read is not idle.
STUB_PEEK='not json' STUB_DRAIN_CODE=200 run "$tag"
[ ! -e "$tmp/installed" ] || fail "installed on an unreadable drain answer"

# --now installs without asking for a drain.
STUB_PEEK="$waiting" STUB_DRAIN_CODE=200 run "$tag" --now
[ -e "$tmp/installed" ] || fail "--now did not install"
[ ! -e "$STUB_LOG" ] || fail "--now asked for a drain"

# A server without the drain falls back to live-work.sh, whose failure is not idle.
live_work 3
STUB_PEEK='Not Found' STUB_DRAIN_CODE=404 run "$tag"
[ ! -e "$tmp/installed" ] || fail "installed while live-work.sh failed"
grep -q 'live-work.sh failed (exit 3)' <<<"$out" || fail "no log of the failed live-work check"
live_work 0
STUB_PEEK='Not Found' STUB_DRAIN_CODE=404 run "$tag"
[ -e "$tmp/installed" ] || fail "the live-work.sh fallback did not install when idle"
# A server whose MCP auth answers for the drain route has no drain either; any
# other refusal is a failed request, not idle.
STUB_PEEK='{"error":"invalid_mcp_credential","message":"A valid T3 Code MCP credential is required."}' STUB_DRAIN_CODE=401 run "$tag"
[ -e "$tmp/installed" ] || fail "an MCP-auth 401 on the drain did not fall back to live-work.sh"
STUB_PEEK='Unauthorized' STUB_DRAIN_CODE=401 run "$tag"
[ ! -e "$tmp/installed" ] || fail "installed on a 401 that is not MCP auth"

# --schedule from an agent's shell names that agent's session in the job.
CLAUDE_CODE_SESSION_ID=claude-session-1 run --schedule "$tag"
plist="$tmp/Library/LaunchAgents/org.example.fork.deploy-when-idle-abc1234.plist"
/usr/bin/python3 -c 'import plistlib,sys; a=plistlib.load(open(sys.argv[1],"rb"))["ProgramArguments"]; sys.exit(a[-2:] != ["--requester", "claude-session-1"])' "$plist" ||
  fail "the scheduled job does not pass the requesting session"
# The scheduled copy reads its hosts and IDs from a fork.env installed beside it.
[ -f "$tmp/t3-fork/fork.env" ] || fail "--schedule did not install fork.env beside the job's script"
mkdir -p "$tmp/Applications/ExternalLauncher.app/Contents/MacOS"
launcher="$tmp/Applications/ExternalLauncher.app/Contents/MacOS/ExternalLauncher"
install -m 755 /dev/null "$launcher"
# With ExternalLauncher installed but ~/t3-fork a real directory, the job runs its script directly.
CLAUDE_CODE_SESSION_ID= CODEX_THREAD_ID= run --schedule "$tag" --now
/usr/bin/python3 -c 'import plistlib,sys; d=plistlib.load(open(sys.argv[1],"rb")); h=sys.argv[2]; sys.exit(d["ProgramArguments"] != ["/bin/bash", h+"/t3-fork/deploy-when-idle.sh", "fork-1.0.0-abc1234", "--now"] or d["StandardOutPath"] != h+"/t3-fork/logs/deploy-when-idle-abc1234.log" or "WorkingDirectory" in d)' "$plist" "$tmp" ||
  fail "with ~/t3-fork on the internal disk the scheduled job does not run its script directly"
# With ExternalLauncher installed and ~/t3-fork a symlink onto a volume, the job runs
# through it and logs on the internal disk.
mv "$tmp/t3-fork" "$tmp/volume-t3-fork" && ln -s "$tmp/volume-t3-fork" "$tmp/t3-fork"
CLAUDE_CODE_SESSION_ID= CODEX_THREAD_ID= run --schedule "$tag" --now
/usr/bin/python3 -c 'import plistlib,sys; d=plistlib.load(open(sys.argv[1],"rb")); log=sys.argv[3]+"/Library/Logs/external-launcher/org.example.fork.deploy-when-idle-abc1234.log"; sys.exit(d["ProgramArguments"] != [sys.argv[2], "t3-deploy-when-idle", "fork-1.0.0-abc1234", "--now"] or d["StandardOutPath"] != log or d["WorkingDirectory"] != sys.argv[3]+"/Library/Logs/external-launcher")' "$plist" "$launcher" "$tmp" ||
  fail "with ExternalLauncher installed the scheduled job does not run through it"

# Linux: --schedule writes a systemd user timer and service instead of a plist, and the
# install takes the linux-x64 archive and then retires the timer.
units="$tmp/.config/systemd/user"
label=org.example.fork.deploy-when-idle-abc1234
rm -f "$STUB_LOG.systemctl"
STUB_UNAME=Linux CLAUDE_CODE_SESSION_ID=claude-session-1 run --schedule "$tag"
grep -qx "ExecStart=/bin/bash $tmp/t3-fork/deploy-when-idle.sh $tag --requester claude-session-1" "$units/$label.service" ||
  fail "the Linux job does not run the installed copy for the requesting session"
grep -qx "OnUnitInactiveSec=30s" "$units/$label.timer" || fail "the Linux timer does not repeat every 30 s"
grep -qx -- "--user enable --now $label.timer" "$STUB_LOG.systemctl" || fail "the Linux timer was not started"
live_work 0
STUB_UNAME=Linux STUB_PEEK="$drained" STUB_DRAIN_CODE=200 run "$tag"
grep -qx "$dir/t3-1.0.0+new-linux-x64.tar.gz" "$tmp/installed" 2>/dev/null || fail "Linux did not install the linux-x64 archive"
[ ! -e "$units/$label.timer" ] && grep -qx -- "--user disable --now $label.timer" "$STUB_LOG.systemctl" ||
  fail "the Linux timer was not retired after the install"

# Linux asked the artifacts server, not GitHub, for the newest release.
[ ! -e "$STUB_LOG.gh" ] || fail "Linux called gh: $(cat "$STUB_LOG.gh")"

# A release not downloaded yet: a Mac takes its files from the GitHub release and its
# darwin archive from the artifacts server; Linux takes everything from the artifacts
# server, without gh. Both check the archive against SHA256SUMS before installing.
rm -rf "$dir"
run "$tag" --now
grep -qx "$dir/t3-1.0.0+new-darwin-arm64.tar.gz" "$tmp/installed" 2>/dev/null || fail "a Mac did not install the downloaded release"
grep -q "^release download $tag -R example/julia --clobber -D $dir.partial$" "$STUB_LOG.gh" || fail "a Mac did not download the GitHub release"
[ ! -e "$dir/t3-1.0.0+new-linux-x64.tar.gz" ] || fail "a Mac downloaded the linux-x64 archive"
rm -rf "$dir"
STUB_UNAME=Linux run "$tag" --now
grep -qx "$dir/t3-1.0.0+new-linux-x64.tar.gz" "$tmp/installed" 2>/dev/null || fail "Linux did not install the downloaded release"
[ ! -e "$STUB_LOG.gh" ] || fail "Linux called gh: $(cat "$STUB_LOG.gh")"
[ -f "$dir/fork-scripts.tar.gz" ] && [ ! -e "$dir/t3-1.0.0+new-darwin-arm64.tar.gz" ] ||
  fail "Linux did not download exactly its release files from the artifacts server"
# A corrupted transfer fails the checksum and installs nothing.
rm -rf "$dir"
cp "$served/1.0.0+new/t3-1.0.0+new-linux-x64.tar.gz" "$tmp/good"
echo corrupt > "$served/1.0.0+new/t3-1.0.0+new-linux-x64.tar.gz"
STUB_UNAME=Linux run "$tag" --now
[ ! -e "$tmp/installed" ] && [ ! -e "$dir" ] || fail "Linux installed an archive that failed its checksum"
mv "$tmp/good" "$served/1.0.0+new/t3-1.0.0+new-linux-x64.tar.gz"
# A tag latest-release does not name is not downloaded.
rm -rf "$dir" "$dir.partial"
STUB_UNAME=Linux run fork-0.9.0-old0000 --now
grep -q 'superseded' <<<"$out" && [ ! -e "$tmp/installed" ] || fail "Linux did not treat an older tag as superseded"

[ "$status" = 0 ] && echo ok
exit "$status"
