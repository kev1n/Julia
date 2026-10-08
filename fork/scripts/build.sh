#!/bin/bash
# Build the fork's macOS arm64 server runtime archive and desktop app.
#   fork/scripts/build.sh <version> <output-dir>
# <version> is the upstream nightly plus an ordered fork revision and hash, e.g.
# 0.0.46-nightly.20261007.2787.owner.1791429000+owner.1a2b3c4. Writes
#   <output-dir>/t3-<version>-darwin-arm64.tar.gz   (server runtime)
#   <output-dir>/T3-Code-*-arm64.zip                (T3 Code (Owner).app)
set -euo pipefail
version=${1:?version}
out=${2:?output dir}
repo=$(git rev-parse --show-toplevel)
cd "$repo"
mkdir -p "$out"
out=$(cd "$out" && pwd)
export PATH="$HOME/.local/share/vite-plus/bin:$HOME/.cargo/bin:$PATH"
unset GITHUB_REPOSITORY T3CODE_DESKTOP_UPDATE_REPOSITORY # no update feed in the app
# The web build reads APP_VERSION before package.json; a value left in the shell
# (seen on the MacBook) would make every server look out of date.
export APP_VERSION="$version"

stamped=(apps/desktop/package.json apps/server/package.json apps/web/package.json packages/contracts/package.json)
work=$(mktemp -d)
cleanup() { git checkout -- "${stamped[@]}"; rm -rf "$work"; }
trap cleanup EXIT

vp i
node scripts/update-release-package-versions.ts "$version"
vp run build:desktop

cargo +stable build --locked --release --manifest-path native/resource-monitor/Cargo.toml
mkdir -p "$work/resource-monitor/darwin-arm64"
cp native/resource-monitor/target/release/t3-resource-monitor "$work/resource-monitor/darwin-arm64/"

# The single executable needs the Node release pinned in apps/server/vite.config.ts.
sea_node=$(sed -n 's/^const SEA_NODE_VERSION = "\(.*\)";/\1/p' apps/server/vite.config.ts)
PATH="$HOME/.local/share/vite-plus/fallback-bin:$PATH" VP_NODE_VERSION="$sea_node" \
  node apps/server/scripts/cli.ts build-exe
node scripts/build-cli-archive.ts --platform mac --arch arm64 --version "$version" \
  --resource-monitor-dir "$work/resource-monitor" --output-dir "$out"

T3CODE_DESKTOP_PRODUCT_NAME="T3 Code (Owner)" T3CODE_DESKTOP_APP_ID=com.example.julia T3CODE_DESKTOP_PACKAGE_NAME=julia-fork \
  vp run dist:desktop:artifact --platform mac --target dmg --arch arm64 \
  --build-version "$version" --skip-build --output-dir "$out"
rm -f "$out"/*.blockmap "$out"/builder-debug.yml "$out"/*.dmg
echo "$version" > "$out/VERSION"
ls -la "$out"
