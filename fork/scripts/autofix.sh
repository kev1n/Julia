#!/bin/bash
# When the daily sync cannot rebase, check or build the fork, hand the problem to
# a Claude chat on this Mac's T3 Code server (it shows in Owner's app) and judge
# what it leaves behind. Called by sync.sh; it never pushes or publishes.
#   fork/scripts/autofix.sh <upstream-ref> <fork-head> <problem> <sync-log> <dir>
# The agent works in the git worktree <dir>/worktree on branch autofix/<stamp>,
# started at <fork-head>, and writes <dir>/report.md. Exit 0 and <dir>/result
# (the fixed commit) only when its branch is a finished rebase onto
# <upstream-ref> that keeps the fork's commit series and does not weaken checks
# or tests; sync.sh then reruns the same checks and build on it before publishing.
# <dir>/thread.json (environment and thread ids) and <dir>/verdict explain the outcome.
set -uo pipefail
latest=${1:?upstream ref}
before=${2:?fork head}
problem=${3:?problem}
sync_log=${4:?sync log}
dir=${5:?work dir}
repo=$(git rev-parse --show-toplevel)
here="$repo/fork/scripts"
worktree="$dir/worktree"
branch="autofix/$(basename "$dir")"
report="$dir/report.md"
base=$(git describe --tags --abbrev=0 --match 'v*-nightly.*' "$before")
mkdir -p "$dir"
verdict() { echo "$1" > "$dir/verdict"; echo "autofix: $1"; exit 1; }

git worktree add -q -B "$branch" "$worktree" "$before" || verdict "could not create the worktree $worktree"
commits=$(git log --reverse --format='%h %s' "$base..$before")
# Build with a version shaped like the sync's own (build.sh needs semver).
case "$latest" in
  v*-nightly.*) upstream_version=${latest#v} ;;
  *) upstream_version=$(git show "$latest:apps/server/package.json" | /usr/bin/python3 -c 'import json,sys; print(json.load(sys.stdin)["version"])') ;;
esac
version="$upstream_version+owner.autofix"
# The chat's shell inherits the T3 Code service's variables, which the sync's
# own (launchd) environment lacks; upstream tests read them (and T3CODE_HOME
# points at the live install), so the agent runs the commands without them.
clean_env="env -u T3CODE_HOME -u T3_SERVICE_LAUNCHER_CONTEXT -u T3_BOOT_SERVICE_UNIT"
cat > "$dir/prompt.md" <<PROMPT
The daily sync of Owner's T3 Code fork (owner/t3code, branch \`owner\`) failed on build-mac and nobody is watching: work unattended, never ask a question, and finish in this one turn.

## What failed

$problem

Sync log: $sync_log

## Your job

You are in a git worktree on branch \`$branch\`, at the fork head \`$before\` (origin/owner). The fork is upstream \`$base\` plus these commits, one series per feature:

\`\`\`
$commits
\`\`\`

1. \`git rebase $latest\` (skip if the branch is already on \`$latest\`). Resolve each conflict inside the commit being replayed, then \`git rebase --continue\`. Read FORK.md and the commit's own intent first: keep upstream's new behaviour and re-apply the fork's change on top of it.
2. Run exactly these, in order, and fix what fails (the \`env -u\` prefix gives them the sync's environment instead of the T3 Code service's):
   \`$clean_env fork/scripts/checks.sh $latest\`
   \`$clean_env fork/scripts/build.sh "$version" "$dir/build"\`
   \`$clean_env fork/scripts/build-mobile.sh build "$version" "$dir/build" "\$HOME/t3-fork/out/mobile"\`
   Fix a failure inside the fork commit it belongs to (\`git commit --fixup=<sha>\`, then \`GIT_SEQUENCE_EDITOR=: git rebase -i --autosquash $latest\`), never as a new commit on top, and rerun all three until every one passes.
3. Leave the branch at the result with no rebase in progress.

## Rules (the sync checks these mechanically and rejects your branch otherwise)

- The commit list after \`$latest\` must have exactly the subjects above, in the same order. No "fix conflicts" commit.
- Do not touch anything under \`fork/\` (the checks and build scripts), and do not delete, skip, \`.only\` or weaken tests, or add \`@ts-ignore\`, \`@ts-expect-error\`, \`@ts-nocheck\`, or lint-disable comments. If the only way to green is one of these, stop and say so.
- Do not push, publish, open issues, or touch \`~/src/t3code-fork\`, the \`owner\` branch, \`~/t3-fork/out\`, or \`~/.t3/userdata\`. The sync reruns the same checks and build itself and publishes only if they pass.

## When you finish

Write \`$report\` (outside the repo). First line exactly \`RESOLVED\` or \`UNRESOLVED\`. Then, in plain words for Owner: what conflicted or failed (file and fork commit), how you resolved it, and the result of each of the three commands. If unresolved: why, and what a human should do next.
PROMPT

echo "autofix: launching a Claude chat on $(hostname -s) in $worktree"
node "$here/autofix-thread.mjs" "$repo" "$worktree" "Fork sync auto-fix: $latest" "$dir/prompt.md" > "$dir/thread.json" ||
  verdict "could not run the chat on the T3 Code server"
cat "$dir/thread.json"
status=$(/usr/bin/python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["status"])' "$dir/thread.json")

[ -f "$report" ] || verdict "the agent stopped ($status) without writing $report"
[ "$(head -1 "$report")" = "RESOLVED" ] || verdict "the agent could not resolve it (its report says $(head -1 "$report"))"
git -C "$worktree" rev-parse -q --verify REBASE_HEAD >/dev/null && verdict "the agent left a rebase in progress"
result=$(git rev-parse "$branch")
git merge-base --is-ancestor "$latest" "$result" || verdict "the agent's branch is not on $latest"
[ "$(git log --reverse --format=%s "$base..$before")" = "$(git log --reverse --format=%s "$latest..$result")" ] ||
  verdict "the agent's branch changed the fork's commit series (added, dropped, reordered or renamed commits)"
git diff --quiet "$before" "$result" -- fork || verdict "the agent changed files under fork/ (the checks and build scripts)"

# What the fork adds on top of upstream must not lose test cases or gain skips,
# focus, type suppressions or lint disables, compared with before the sync.
count() { git grep -h -E "$1" "$2" -- "${@:3}" 2>/dev/null | wc -l; }
fork_delta() { echo $(($(count "$1" "$before" "${@:2}") - $(count "$1" "$base" "${@:2}"))) $(($(count "$1" "$result" "${@:2}") - $(count "$1" "$latest" "${@:2}"))); }
tests='^[[:space:]]*(it|test)(\.[a-zA-Z]+)*\('
read -r was now <<<"$(fork_delta "$tests" '*.test.ts' '*.test.tsx')"
[ "$now" -ge "$was" ] || verdict "the fork's test cases went from $was to $now"
weakeners='\.(skip|only|todo|skipIf|runIf)\(|@ts-(ignore|nocheck|expect-error)|(eslint|oxlint)-disable'
read -r was now <<<"$(fork_delta "$weakeners" '*.ts' '*.tsx')"
[ "$now" -le "$was" ] || verdict "the fork's skips, type suppressions or lint disables went from $was to $now"

echo "$result" > "$dir/result"
echo "agent's branch $result passed the guards" > "$dir/verdict"
echo "autofix: $(cat "$dir/verdict")"
