#!/bin/bash
# Remove the sync's auto-fix runs (~/t3-fork/autofix/<stamp>) once a release is
# published: the fork is current, so nobody needs to continue from them. Called by
# sync.sh after it publishes. A run stays while a process has its cwd inside it or
# its worktree has changes (git worktree remove without --force refuses); the
# autofix/<stamp> branch is kept either way.
#   fork/scripts/prune-autofix.sh
set -uo pipefail
repo=$(git rev-parse --show-toplevel) || exit 1
autofix="$HOME/t3-fork/autofix"
[ -d "$autofix" ] || exit 0
# Failure to see which folders are in use means no cleanup.
cwds=$(/usr/sbin/lsof -n -a -u "$(id -u)" -d cwd -Fn) || { echo "prune-autofix: lsof failed"; exit 1; }
in_use() { # lsof -Fn prints each cwd as a line "n<path>"
  printf '%s\n' "$cwds" | awk -v p="n$1" '$0 == p || index($0, p "/") == 1 { found = 1 } END { exit !found }'
}
# Delete only real folders directly inside the resolved autofix folder, never through a symlink.
root=$(cd "$autofix" && pwd -P) || exit 1
for entry in "$autofix"/*; do
  if [ -L "$entry" ] || [ -L "$entry/worktree" ]; then
    echo "prune-autofix: kept $entry (a symlink)"
    continue
  fi
  [ -d "$entry" ] || continue
  run=$(cd "$entry" && pwd -P) || continue
  case "$run" in
    "$root"/*/*) continue ;;
    "$root"/?*) ;;
    *) continue ;;
  esac
  if in_use "$run"; then
    echo "prune-autofix: kept $run (a process is working in it)"
    continue
  fi
  if [ -e "$run/worktree" ] && ! git -C "$repo" worktree remove "$run/worktree"; then
    echo "prune-autofix: kept $run (its worktree has changes)"
    continue
  fi
  rm -rf "$run" && echo "prune-autofix: removed $run"
done
