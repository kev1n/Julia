#!/bin/bash
# prune-build-caches.py finds and trims idle checkouts when ~/t3-fork and ~/.t3/worktrees
# are symlinks onto another volume, as on a build Mac whose state lives on an external disk.
#   fork/scripts/prune-build-caches.test.sh
# Runs the real script with a scratch HOME and an empty T3 database, so nothing is protected.
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
tmp=$(cd "$(mktemp -d)" && pwd -P)
trap 'rm -rf "$tmp"' EXIT
status=0
fail() { echo "FAIL: $1"; printf 'output:\n%s\n' "$out"; status=1; }

checkout() { # <dir> <ignored dir>: a clean repository whose ignored dir holds a file
  mkdir -p "$1/$2"
  git -C "$1" init -q
  echo "$2/" > "$1/.gitignore"
  git -C "$1" add .gitignore
  git -C "$1" -c user.name=t -c user.email=t@example.com commit -q -m init
  echo x > "$1/$2/file"
}
checkout "$tmp/external/t3-fork/autofix/20200101-050000/worktree" node_modules
checkout "$tmp/external/worktrees/project/thread" apps/web/dist
mkdir -p "$tmp/home/.t3/userdata"
ln -s "$tmp/external/t3-fork" "$tmp/home/t3-fork"
ln -s "$tmp/external/worktrees" "$tmp/home/.t3/worktrees"
/usr/bin/python3 - "$tmp/home/.t3/userdata/statev2.sqlite" <<'PY'
import sqlite3, sys
db = sqlite3.connect(sys.argv[1])
db.executescript("""
CREATE TABLE orchestration_v2_projection_provider_sessions (payload_json TEXT, status TEXT);
CREATE TABLE orchestration_v2_projection_threads (payload_json TEXT);
CREATE TABLE orchestration_v2_projection_runs (thread_id TEXT, status TEXT, requested_at TEXT, completed_at TEXT);
CREATE TABLE orchestration_v2_effect_outbox (thread_id TEXT, status TEXT);
""")
db.commit()
PY
# Idle for years, so age alone makes both checkouts eligible.
find "$tmp/external" -exec touch -h -t 202001010000 {} +

out=$(cd / && HOME="$tmp/home" /usr/bin/python3 "$here/prune-build-caches.py" --apply 2>&1)
[ -e "$tmp/external/t3-fork/autofix/20200101-050000/worktree/node_modules" ] &&
  fail "the auto-fix checkout behind the symlinked ~/t3-fork kept its node_modules"
[ -e "$tmp/external/worktrees/project/thread/apps/web/dist" ] &&
  fail "the thread checkout behind the symlinked ~/.t3/worktrees kept its build output"
case "$out" in *'"trimmed": []'*) fail "the log line names nothing trimmed" ;; esac
exit $status
