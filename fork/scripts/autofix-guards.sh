#!/bin/bash
# The test and weakening guards autofix.sh applies to an auto-fix branch.
#   fork/scripts/autofix-guards.sh <base> <before> <latest> <result>
# <before> is the fork on upstream <base>; <result> is the agent's rebase of it onto <latest>.
# Exit 1 with the reason on stdout when the branch loses fork tests, drops upstream tests
# outside the files where the fork already removes upstream tests, or adds skips, focus,
# type suppressions or lint disables. Exit 0, printing the upstream tests it dropped, if any.
set -uo pipefail
base=${1:?base} before=${2:?before} latest=${3:?latest} result=${4:?result}
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

# One line per test case, "<file>:<line text>", sorted so comm treats repeats as a multiset.
tests() {
  git grep -E '^[[:space:]]*(it|test)(\.[a-zA-Z]+)*\(' "$1" -- '*.test.ts' '*.test.tsx' 2>/dev/null |
    sed "s|^$1:||" | LC_ALL=C sort > "$tmp/$2"
}
tests "$base" base
tests "$before" before
tests "$latest" latest
tests "$result" result
minus() { LC_ALL=C comm -23 "$tmp/$1" "$tmp/$2"; }

# Tests the fork adds on top of upstream: comparing sets rather than net counts keeps
# upstream tests the fork removes from looking like lost fork tests.
was=$(minus before base | wc -l | tr -d ' ')
now=$(minus result latest | wc -l | tr -d ' ')
[ "$now" -ge "$was" ] || { echo "the fork's own test cases went from $was to $now"; exit 1; }

# The fork deletes some upstream features, and upstream keeps adding tests for them. Such
# tests may go only from a test file the fork already removed upstream tests from.
minus base before > "$tmp/dropped-before"
minus latest result > "$tmp/dropped-now"
LC_ALL=C comm -13 "$tmp/dropped-before" "$tmp/dropped-now" > "$tmp/dropped-new"
cut -d: -f1 "$tmp/dropped-before" | LC_ALL=C sort -u > "$tmp/stripped-files"
outside=$(while IFS= read -r line; do
  grep -qxF "${line%%:*}" "$tmp/stripped-files" || echo "$line"
done < "$tmp/dropped-new")
if [ -n "$outside" ]; then
  echo "the branch drops upstream tests from files the fork did not strip before:"
  echo "$outside"
  exit 1
fi

# Skips, focus, type suppressions and lint disables the fork adds must not grow. Upstream
# requires a reason disable on every React effect, so those do not count.
count() { git grep -h -E "$1" "$2" -- '*.ts' '*.tsx' 2>/dev/null | grep -v 't3code/no-unreasoned-state-sync' | wc -l; }
weakeners='\.(skip|only|todo|skipIf|runIf)\(|@ts-(ignore|nocheck|expect-error)|(eslint|oxlint)-disable'
was=$(($(count "$weakeners" "$before") - $(count "$weakeners" "$base")))
now=$(($(count "$weakeners" "$result") - $(count "$weakeners" "$latest")))
[ "$now" -le "$was" ] || { echo "the fork's skips, type suppressions or lint disables went from $was to $now"; exit 1; }

if [ -s "$tmp/dropped-new" ]; then
  echo "Upstream tests dropped with code the fork removes:"
  cat "$tmp/dropped-new"
fi
