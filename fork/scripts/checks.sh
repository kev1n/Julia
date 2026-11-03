#!/bin/bash
# The checks a synced fork must pass before it is built: no personal host or ID
# in what the fork adds, typecheck of every package the fork touches, lint of every
# file it touches, the fork's own tests, and the upstream tests that sit beside
# the upstream files it changes.
#   fork/scripts/checks.sh <upstream-base-ref>
set -euo pipefail
base=${1:?upstream base ref}
cd "$(git rev-parse --show-toplevel)"
fork/scripts/check-literals.sh "$base"
export PATH="$HOME/.local/share/vite-plus/bin:$PATH"
vp i # a new upstream base can change dependencies
# macOS ships bash 3.2 (no mapfile); file names here contain no newlines.
IFS=$'\n'
touched=($(git diff --name-only --diff-filter=AMR "$base"...HEAD -- '*.ts' '*.tsx'))
vp run --filter @t3tools/contracts --filter @t3tools/web --filter t3 \
  --filter @t3tools/desktop --filter @t3tools/scripts --filter @t3tools/mobile typecheck
vp lint --report-unused-disable-directives "${touched[@]}"
tests=()
for file in "${touched[@]}"; do
  case "$file" in
    *.test.ts | *.test.tsx) tests+=("$file") ;;
    *.tsx) [ -f "${file%.tsx}.test.tsx" ] && tests+=("${file%.tsx}.test.tsx") ;;
    *.ts) [ -f "${file%.ts}.test.ts" ] && tests+=("${file%.ts}.test.ts") ;;
  esac
done
tests=($(printf '%s\n' "${tests[@]}" | sort -u))
# macOS's TMPDIR is a symlink (/var -> /private/var); upstream tests that compare
# temp paths fail on it even on a pristine upstream checkout, so use the real path.
TMPDIR="$(cd "${TMPDIR:-/tmp}" && pwd -P)/" vp test run "${tests[@]}"
