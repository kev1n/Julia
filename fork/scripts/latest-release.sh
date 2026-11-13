#!/bin/bash
# Points the Linux machines at a published release (sync.sh): writes ~/t3-fork/out/latest-release
# ("<tag> <version>"), which they read from the artifacts server (fork_latest_release in
# fork.env) because they hold no GitHub login.
#   fork/scripts/latest-release.sh <tag> [<version>]
# Without <version> it reads the GitHub release's own VERSION, for a run that finds <tag> already
# published (an earlier run may have stopped between publishing and this). A release whose
# out/<version>/ has no linux-x64 archive (its Linux build failed) leaves the file as it was.
set -euo pipefail
. "$(dirname "$0")/fork.env" # fork_repo
tag=${1:?tag}
out="$HOME/t3-fork/out"
if [ -n "${2:-}" ]; then
  version=$2
else
  version=$(gh release download "$tag" -R "$fork_repo" -p VERSION -O -)
fi
if [ ! -f "$out/$version/t3-$version-linux-x64.tar.gz" ]; then
  echo "No linux-x64 archive for $version; latest-release left as it was."
  exit 0
fi
printf '%s %s\n' "$tag" "$version" > "$out/latest-release.partial"
mv "$out/latest-release.partial" "$out/latest-release"
