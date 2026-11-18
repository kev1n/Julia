#!/bin/bash
# prune-autofix.sh removes a settled auto-fix run and its worktree but never deletes
# through a symlink: a run entry or a run's worktree that links outside ~/t3-fork/autofix stays.
#   fork/scripts/prune-autofix.test.sh
set -uo pipefail
prune="$(cd "$(dirname "$0")" && pwd)/prune-autofix.sh"
tmp=$(cd "$(mktemp -d)" && pwd -P)
trap 'rm -rf "$tmp"' EXIT
status=0
fail() { echo "FAIL: $1"; printf 'output:\n%s\n' "$out"; status=1; }

git init -q "$tmp/repo"
git -C "$tmp/repo" -c user.name=t -c user.email=t@example.com commit -q --allow-empty -m init
autofix="$tmp/home/t3-fork/autofix"
mkdir -p "$autofix" "$tmp/outside/unrelated" "$tmp/outside/held"
echo keep > "$tmp/outside/unrelated/sentinel"
# A settled run: its worktree is clean, so it goes and its branch stays.
git -C "$tmp/repo" worktree add -q -b autofix/settled "$autofix/settled/worktree"
# A run entry that is a symlink to an unrelated folder.
ln -s "$tmp/outside/unrelated" "$autofix/linked"
# A real run whose worktree is a symlink to a worktree outside the autofix folder.
git -C "$tmp/repo" worktree add -q -b autofix/held "$tmp/outside/held/worktree"
mkdir -p "$autofix/escape"
ln -s "$tmp/outside/held/worktree" "$autofix/escape/worktree"

out=$(cd "$tmp/repo" && HOME="$tmp/home" "$prune" 2>&1)
[ -e "$autofix/settled" ] && fail "the settled run was kept"
git -C "$tmp/repo" rev-parse -q --verify autofix/settled >/dev/null || fail "the settled run's branch was deleted"
[ -f "$tmp/outside/unrelated/sentinel" ] || fail "deleted the target of a symlinked run"
[ -d "$tmp/outside/held/worktree" ] || fail "deleted a worktree outside the autofix folder through a symlink"
exit $status
