#!/bin/bash
# Fails when a host or ID is written into a fork file instead of read from
# fork.env: any value fork.env sets, a host on a tailnet, a Mac's host name or
# computer name, or a tailnet IP (100.64/10, the range Tailscale assigns).
# Fork files are everything under fork/ and every */src/fork/ directory; upstream
# files the fork changes are not checked.
#   fork/scripts/check-literals.sh
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
cd "$(git -C "$here" rev-parse --show-toplevel)"
env_file="fork/scripts/fork.env"
patterns=(
  'tail[0-9a-f]{6,}\.ts\.net'
  '[a-z0-9]-mac-mini|[a-z0-9]-macbook-'
  "'s (Mac mini|Mac Mini|MacBook)"
  '(^|[^0-9.])100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.[0-9]{1,3}\.[0-9]{1,3}($|[^0-9])'
)
# Every value fork.env sets, as a fixed string.
values=$(env -i /bin/bash -c '
  set -a; . "$1"; set +a
  for name in $(sed -nE "s/^([a-z_]+)=.*/\1/p" "$1"); do printf "%s\n" "${!name}"; done
' _ "$env_file")
IFS=$'\n'
files=($(git ls-files --cached --others --exclude-standard -- fork ':(glob)**/src/fork/**' | grep -vxF "$env_file"))
unset IFS
found=0
for pattern in "${patterns[@]}"; do
  grep -nHE -- "$pattern" "${files[@]}" && found=1
done
while read -r value; do
  [ -n "$value" ] && grep -nHF -- "$value" "${files[@]}" && found=1
done <<< "$values"
if [ "$found" = 1 ]; then
  echo "FAIL: the lines above write a host or ID into a fork file; set it in $env_file and read it from there" >&2
  exit 1
fi
echo "ok: no host or ID literal in ${#files[@]} fork files outside $env_file"
