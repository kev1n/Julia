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
tag=owner-1.0.0-abc1234
dir="$tmp/t3-fork/releases/$tag"
mkdir -p "$dir/scripts" "$tmp/.t3/runtime" "$tmp/.t3/userdata"
echo 1.0.0+new > "$dir/VERSION"
echo '{"activeVersion": "1.0.0+old"}' > "$tmp/.t3/runtime/service-state.json"
echo '{"secret": "fleet-secret"}' > "$tmp/.t3/userdata/fork-fleet.json"
touch "$tmp/t3-fork/desktop-local-build"
printf '#!/bin/bash\ntouch "%s/installed"\n' "$tmp" > "$dir/scripts/install-runtime.sh"
chmod +x "$dir/scripts/install-runtime.sh"
# live-work.sh, exiting with $1 after printing nothing (the old "idle").
live_work() {
  printf '#!/bin/bash\nexit %s\n' "$1" > "$dir/scripts/live-work.sh"
  chmod +x "$dir/scripts/live-work.sh"
}
gh() { echo "$STUB_TAG"; }
# The drain answers a peek with $STUB_PEEK, a start with $STUB_START (default: the
# peek's answer), with HTTP $STUB_DRAIN_CODE, and records each request.
curl() {
  case "$*" in
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
export -f gh curl launchctl
export STUB_TAG="$tag" STUB_LOG="$tmp/drain-requests"
status=0
fail() { echo "FAIL: $1"; printf 'output:\n%s\n' "$out"; status=1; }
run() {
  rm -f "$tmp/installed" "$STUB_LOG"
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
grep -q '"action": "peek", "release": "owner-1.0.0-abc1234", "requester": "claude-session-1"' "$STUB_LOG" ||
  fail "the request did not carry the release and the requesting session"
grep -q 'Authorization: Bearer fleet-secret' "$STUB_LOG" || fail "the request was not authorized"

# Idle, and the drain is idle too: install, logging the requester's work it left out.
STUB_PEEK="$drained" STUB_DRAIN_CODE=200 run "$tag" --requester claude-session-1
[ -e "$tmp/installed" ] || fail "did not install once drained"
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

# --schedule from an agent's shell names that agent's session in the job.
CLAUDE_CODE_SESSION_ID=claude-session-1 run --schedule "$tag"
plist="$tmp/Library/LaunchAgents/com.example.t3code-fork.deploy-when-idle-abc1234.plist"
/usr/bin/python3 -c 'import plistlib,sys; a=plistlib.load(open(sys.argv[1],"rb"))["ProgramArguments"]; sys.exit(a[-2:] != ["--requester", "claude-session-1"])' "$plist" ||
  fail "the scheduled job does not pass the requesting session"
# The scheduled copy reads its hosts and IDs from a fork.env installed beside it.
[ -f "$tmp/t3-fork/fork.env" ] || fail "--schedule did not install fork.env beside the job's script"
# With ExternalLauncher installed, the job runs through it and logs on the internal disk.
mkdir -p "$tmp/Applications/ExternalLauncher.app/Contents/MacOS"
launcher="$tmp/Applications/ExternalLauncher.app/Contents/MacOS/ExternalLauncher"
install -m 755 /dev/null "$launcher"
CLAUDE_CODE_SESSION_ID= CODEX_THREAD_ID= run --schedule "$tag" --now
/usr/bin/python3 -c 'import plistlib,sys; d=plistlib.load(open(sys.argv[1],"rb")); log=sys.argv[3]+"/Library/Logs/external-launcher/com.example.t3code-fork.deploy-when-idle-abc1234.log"; sys.exit(d["ProgramArguments"] != [sys.argv[2], "t3-deploy-when-idle", "owner-1.0.0-abc1234", "--now"] or d["StandardOutPath"] != log or d["WorkingDirectory"] != sys.argv[3]+"/Library/Logs/external-launcher")' "$plist" "$launcher" "$tmp" ||
  fail "with ExternalLauncher installed the scheduled job does not run through it"

[ "$status" = 0 ] && echo ok
exit "$status"
