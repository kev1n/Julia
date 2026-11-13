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

# Writes the named test files (name=case,case,...) and commits them under tag $1.
snapshot() {
  local tag=$1 spec name cases
  shift
  git rm -rq --ignore-unmatch . >/dev/null
  for spec in "$@"; do
    name=${spec%%=*} cases=${spec#*=}
    tr ',' '\n' <<<"$cases" | sed '/^$/d; s/.*/it("&", () => {});/' > "$name.test.ts"
  done
  git add -A && git commit -qm "$tag" --allow-empty && git tag "$tag"
}
expect() {
  local want=$1 label=$2 out
  out=$("$guards" base before latest "$3")
  local got=$?
  if [ "$got" -ne "$want" ]; then
    echo "FAIL: $label (exit $got, want $want): $out"
    failures=$((failures + 1))
  fi
}

# The fork adds f1 and strips upstream's settle tests; upstream then adds settle s3.
snapshot base settle=s1,s2 core=c1
snapshot before settle= core=c1 fork=f1
snapshot latest settle=s1,s2,s3 core=c1,c2
snapshot ok settle= core=c1,c2 fork=f1
expect 0 "a new upstream test leaves with code the fork removes" ok
snapshot lost-fork settle= core=c1,c2 fork=
expect 1 "a fork test is lost" lost-fork
snapshot dropped-core settle= core=c1 fork=f1
expect 1 "an upstream test goes from a file the fork never stripped" dropped-core
snapshot skipped settle= core=c1,c2 fork=f1
echo 'it.skip("x", () => {});' >> core.test.ts && git commit -qam skip && git tag -f skipped >/dev/null
expect 1 "a skip is added" skipped

[ "$failures" -eq 0 ] && echo "autofix-guards: ok"
exit "$failures"
