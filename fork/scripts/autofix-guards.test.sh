#!/bin/bash
# autofix-guards.sh accepts an auto-fix branch that drops new upstream tests along with
# code the fork already removes, and rejects one that loses fork tests, drops upstream
# tests elsewhere, or adds a skip.
#   fork/scripts/autofix-guards.test.sh
set -uo pipefail
guards="$(cd "$(dirname "$0")" && pwd)/autofix-guards.sh"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
cd "$tmp" && git init -q && git config user.email t@example.com && git config user.name t
failures=0

# Writes the named test files (name=case,case,...) and commits them under tag $1, with
# subject $subject (default the tag), so a fork commit keeps its subject across a rebase.
snapshot() {
  local tag=$1 spec name cases
  shift
  git rm -rq --ignore-unmatch . >/dev/null
  for spec in "$@"; do
    name=${spec%%=*} cases=${spec#*=}
    tr ',' '\n' <<<"$cases" | sed '/^$/d; s/.*/it("&", () => {});/' > "$name.test.ts"
  done
  git add -A && git commit -qm "${subject:-$tag}" --allow-empty && git tag "$tag"
}
expect() {
  local want=$1 label=$2 out
  out=$("$guards" base "${4:-before}" latest "$3")
  local got=$?
  if [ "$got" -ne "$want" ]; then
    echo "FAIL: $label (exit $got, want $want): $out"
    failures=$((failures + 1))
  fi
}

# The fork adds f1 and strips upstream's settle tests; upstream then adds settle s3.
snapshot base settle=s1,s2 core=c1
subject='fork change' snapshot before settle= core=c1 fork=f1
snapshot latest settle=s1,s2,s3 core=c1,c2
# Each result below is a rebase of before onto latest, so it starts from latest.
result() { git checkout -q --detach latest && subject='fork change' snapshot "$@"; }
result ok settle= core=c1,c2 fork=f1
expect 0 "a new upstream test leaves with code the fork removes" ok
result lost-fork settle= core=c1,c2 fork=
expect 1 "a fork test is lost" lost-fork
result dropped-core settle= core=c1 fork=f1
expect 1 "an upstream test goes from a file the fork never stripped" dropped-core
result skipped settle= core=c1,c2 fork=f1
echo 'it.skip("x", () => {});' >> core.test.ts && git commit -q --amend -a --no-edit && git tag -f skipped >/dev/null
expect 1 "a skip is added" skipped
# Same tree as ok, so only the series guard can reject it.
git checkout -q --detach ok && git commit -q --amend -m 'renamed change' && git tag renamed
expect 1 "a fork commit is renamed" renamed

# A fork whose main merged a pull request with GitHub's button: the rebase drops the
# merge commit and keeps the commit it merged, which is not a change to the series.
# A fixed date keeps pr-head from being the same commit as before when both land in one second.
git checkout -q --detach base && git checkout -q -b pr &&
  GIT_AUTHOR_DATE='1000000000 +0000' GIT_COMMITTER_DATE='1000000000 +0000' subject='fork change' snapshot pr-head settle= core=c1 fork=f1
git checkout -q --detach base && git merge -q --no-ff pr -m 'Merge pull request #2 from someone/pr' && git tag merged
expect 0 "a rebase flattens a pull request's merge commit" ok merged
expect 1 "a rebase that renames the merged commit" renamed merged
git tag merged-upstream "$(git commit-tree 'ok^{tree}' -p merged -p latest -m 'fix conflicts')"
expect 1 "the agent merges upstream instead of rebasing" merged-upstream merged

[ "$failures" -eq 0 ] && echo "autofix-guards: ok"
exit "$failures"
