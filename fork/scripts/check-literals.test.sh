#!/bin/bash
# check-literals.sh fails on a personal host or ID in a line the fork adds against its
# upstream base tag (committed, uncommitted or untracked), from its built-in patterns and
# from the denylist in ~/.config/julia/denylist, and ignores upstream's own lines; with
# --commit (the pre-push hook) it checks only that commit's lines, never the working tree.
#   fork/scripts/check-literals.test.sh
# Runs the real script in a scratch repository with a scratch HOME.
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
repo="$tmp/repo"
mkdir -p "$repo/fork/scripts" "$tmp/home"
install -m 755 "$here/check-literals.sh" "$repo/fork/scripts/check-literals.sh"
git() { command git -C "$repo" -c user.name=test -c user.email=test@example.com "$@"; }
git init -q
# The fixtures are assembled at run time, so this file itself passes the check.
tailnet=tail0123abc ip_prefix=100.101
# Upstream's own line names a tailnet host; the fork never touched it.
echo "upstream example: box.$tailnet.ts.net" > "$repo/upstream.txt"
git add -A && git commit -qm upstream && git tag v1.0.0-nightly.1
echo 'fork line' >> "$repo/upstream.txt"
git commit -qam fork
status=0
fail() { echo "FAIL: $1"; printf 'output:\n%s\n' "$out"; status=1; }
run() { out=$(cd "$repo" && env -i HOME="$tmp/home" PATH="$PATH" /bin/bash fork/scripts/check-literals.sh "$@" 2>&1); }

run || fail "flagged upstream's own line or a clean fork change"

echo "the hub at studio.$tailnet.ts.net" > "$repo/fork/notes.txt"
run && fail "missed a tailnet host in an untracked fork file"
grep -q '^fork/notes.txt:1:' <<<"$out" || fail "did not name the file and line"
rm "$repo/fork/notes.txt"

printf 'ok\nserver at %s.102.103\n' "$ip_prefix" >> "$repo/upstream.txt"
run && fail "missed a tailnet IP added to an upstream file"
grep -q '^upstream.txt:4:server at' <<<"$out" || fail "did not name the added line"
git show HEAD:upstream.txt > "$repo/upstream.txt"

printf 'owner: Alice-Example\n' > "$repo/fork/owner.txt"
git add -A && git commit -qm owner
run || fail "failed without a denylist on a line no built-in pattern matches"
mkdir -p "$tmp/home/.config/julia"
printf 'other-name\nalice-example' > "$tmp/home/.config/julia/denylist" # no final newline
run && fail "missed a committed denylisted string (case-insensitive, last line)"
grep -q '^fork/owner.txt:1:owner: Alice-Example' <<<"$out" || fail "did not name the denylisted line"

run --commit HEAD && fail "--commit missed a denylisted string in the commit"
grep -q '^fork/owner.txt:1:' <<<"$out" || fail "--commit did not name the denylisted line"
echo 'scratch: alice-example' > "$repo/fork/scratch.txt"
run --commit HEAD~1 || fail "--commit read the working tree (a committed file the commit lacks, or an untracked one)"

git rm -q fork/owner.txt && git commit -qm 'drop owner'
run --commit HEAD || fail "--commit flagged a clean commit identity"
GIT_AUTHOR_NAME=Alice-Example GIT_AUTHOR_EMAIL=1+alice-example@users.noreply.github.com git commit -q --allow-empty -m noreply
run --commit HEAD || fail "--commit flagged a GitHub noreply identity"
GIT_AUTHOR_EMAIL=alice-example@example.com git commit -q --allow-empty -m personal
run --commit HEAD && fail "--commit missed a denylisted author email"

[ "$status" = 0 ] && echo ok
exit "$status"
