#!/bin/bash
# install-jobs.sh writes plists that run the job's script directly, or, where
# ExternalLauncher.app is installed and ~/t3-fork is a symlink onto a removable volume,
# through it with launchd's log on the internal disk.
#   fork/scripts/install-jobs.test.sh
# Runs the real script against a scratch HOME; launchctl is stubbed by a script first
# on PATH, checked before any run so the real one is never reached.
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/bin" "$tmp/.config/julia"
# The labels come from the local config that fork.env reads.
echo 'job_label_prefix=org.example.fork' > "$tmp/.config/julia/fork.env"
printf '#!/bin/bash\necho "$*" >> "%s/launchctl"\n' "$tmp" > "$tmp/bin/launchctl"
chmod +x "$tmp/bin/launchctl"
export PATH="$tmp/bin:$PATH"
[ "$(command -v launchctl)" = "$tmp/bin/launchctl" ] || { echo "FAIL: launchctl is not stubbed"; exit 1; }
status=0
fail() { echo "FAIL: $1"; printf 'output:\n%s\n' "$out"; status=1; }
run() {
  out=$(HOME="$tmp" /bin/bash "$here/install-jobs.sh" "$@" 2>&1)
}
agents="$tmp/Library/LaunchAgents"
# check <label> <python condition on the plist d>
check() {
  /usr/bin/python3 -c 'import plistlib,sys; d=plistlib.load(open(sys.argv[1],"rb")); h=sys.argv[3]; sys.exit(not eval(sys.argv[2]))' \
    "$agents/$1.plist" "$2" "$tmp"
}

# No launcher: the job runs its script with bash, logging under ~/t3-fork.
run watchdog
check org.example.fork.watchdog \
  'd["ProgramArguments"] == ["/bin/bash", h+"/t3-fork/watchdog.sh"] and d["StandardOutPath"] == h+"/t3-fork/logs/watchdog.log" and "WorkingDirectory" not in d' ||
  fail "without ExternalLauncher the watchdog does not run its script directly"

mkdir -p "$tmp/Applications/ExternalLauncher.app/Contents/MacOS"
launcher="$tmp/Applications/ExternalLauncher.app/Contents/MacOS/ExternalLauncher"
printf '\0t3-deploy\0t3-watchdog\0' > "$launcher"
chmod 755 "$launcher"
# Launcher installed but ~/t3-fork a real directory (internal disk): still direct.
run watchdog
check org.example.fork.watchdog \
  'd["ProgramArguments"] == ["/bin/bash", h+"/t3-fork/watchdog.sh"] and d["StandardOutPath"] == h+"/t3-fork/logs/watchdog.log" and "WorkingDirectory" not in d' ||
  fail "with ~/t3-fork on the internal disk the watchdog does not run its script directly"

# ~/t3-fork a symlink onto a volume, with the launcher: [launcher, service], launchd's log
# and cwd on the internal disk, the job's other keys unchanged.
mv "$tmp/t3-fork" "$tmp/volume-t3-fork" && ln -s "$tmp/volume-t3-fork" "$tmp/t3-fork"
logs="h+\"/Library/Logs/external-launcher\""
run watchdog deploy
check org.example.fork.watchdog \
  "d == {'Label': 'org.example.fork.watchdog', 'ProgramArguments': [h+'/Applications/ExternalLauncher.app/Contents/MacOS/ExternalLauncher', 't3-watchdog'], 'StartInterval': 60, 'WorkingDirectory': $logs, 'StandardOutPath': $logs+'/org.example.fork.watchdog.log', 'StandardErrorPath': $logs+'/org.example.fork.watchdog.log'}" ||
  fail "with ExternalLauncher the watchdog does not run through it"
check org.example.fork.deploy \
  "d['ProgramArguments'][1:] == ['t3-deploy'] and d['StartCalendarInterval'] == {'Hour': 5, 'Minute': 45} and d['StandardErrorPath'] == $logs+'/org.example.fork.deploy.log'" ||
  fail "with ExternalLauncher the deploy job does not run through it"
# A job the launcher has no service for is refused rather than left looping.
run sync && fail "installed sync though ExternalLauncher has no t3-sync"
[ ! -e "$agents/org.example.fork.sync.plist" ] || fail "wrote a sync plist ExternalLauncher cannot run"

[ "$status" = 0 ] && echo ok
exit "$status"
