#!/bin/bash
# Fails when a personal host or ID is written into what the fork adds to upstream:
# a host on a tailnet, a Mac's host name or computer name, a tailnet IP (100.64/10,
# the range Tailscale assigns), or a line of your own denylist,
# ~/.config/julia/denylist (one fixed string per line, matched case-insensitively;
# your host names, accounts, emails, label prefixes). Such values belong in
# ~/.config/julia/fork.env (FORK.md), never in the repository.
# Checked: every line the fork adds or changes against the upstream nightly tag it
# is based on (committed, uncommitted or untracked), so upstream's own lines are not.
#   fork/scripts/check-literals.sh [upstream-base-ref]
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
cd "$(git -C "$here" rev-parse --show-toplevel)"
base=${1:-$(git describe --tags --abbrev=0 --match 'v*-nightly.*' HEAD)}
denylist="$HOME/.config/julia/denylist"
patterns=(
  'tail[0-9a-f]{6,}\.ts\.net'
  '[a-z0-9]-mac-mini|[a-z0-9]-macbook-'
  "'s (Mac mini|Mac Mini|MacBook)"
  '(^|[^0-9.])100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.[0-9]{1,3}\.[0-9]{1,3}($|[^0-9])'
)
# Every added line as <file>:<line>:<text>.
added=$(
  {
    git diff -U0 --no-color --no-ext-diff --no-renames "$base" -- . | awk '
      /^diff --git / { header = 1; next }
      header && /^\+\+\+ / { file = substr($0, 7); next }
      /^@@ / { header = 0; split($3, range, ","); line = substr(range[1], 2); next }
      !header && /^\+/ { print file ":" line ":" substr($0, 2); line++ }'
    git ls-files --others --exclude-standard -z | xargs -0 grep -nHI '' -- 2>/dev/null || true
  }
)
found=0
for pattern in "${patterns[@]}"; do
  grep -E -- ":[0-9]+:.*($pattern)" <<< "$added" && found=1
done
if [ -f "$denylist" ]; then
  while IFS= read -r value || [ -n "$value" ]; do
    [ -n "$value" ] && grep -iF -- "$value" <<< "$added" && found=1
  done < "$denylist"
fi
if [ "$found" = 1 ]; then
  echo "FAIL: the lines above write a personal host or ID into the fork; set it in ~/.config/julia/fork.env and read it from fork/scripts/fork.env" >&2
  exit 1
fi
[ -f "$denylist" ] && checked="generic patterns and $denylist" || checked="generic patterns only (no $denylist)"
echo "ok: no personal host or ID in the fork's changes since $base ($checked)"
