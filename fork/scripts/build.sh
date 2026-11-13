#!/bin/bash
# Build the fork's server runtime archives (macOS arm64, Linux x64) and desktop app.
#   fork/scripts/build.sh <version> <output-dir>
# <version> is the upstream nightly plus an ordered fork revision and hash, e.g.
# 0.0.46-nightly.20261007.2787.fork.1791429000+fork.1a2b3c4. Writes
#   <output-dir>/t3-<version>-darwin-arm64.tar.gz   (server runtime, the Macs)
#   <output-dir>/t3-<version>-linux-x64.tar.gz      (server runtime, Linux machines)
#   <output-dir>/T3-Code-*-arm64.zip                (Julia.app)
set -euo pipefail
version=${1:?version}
out=${2:?output dir}
repo=$(git rev-parse --show-toplevel)
cd "$repo"
# desktop_bundle_id, desktop_package_name, desktop_home_dirname, artifacts_url
. fork/scripts/fork.env
mkdir -p "$out"
out=$(cd "$out" && pwd)
export PATH="$HOME/.local/share/vite-plus/bin:$HOME/.local/share/vite-plus/fallback-bin:$HOME/.cargo/bin:$PATH"
unset GITHUB_REPOSITORY T3CODE_DESKTOP_UPDATE_REPOSITORY # no update feed in the app
# The web build reads APP_VERSION before package.json; a value left in the shell
# would make every server look out of date.
export APP_VERSION="$version"
# Where this build's servers fetch fork runtimes for Update all (packages/shared/src/cliRelease.ts).
export T3CODE_FORK_RELEASE_BASE_URL="$artifacts_url"

identity=apps/desktop/src/fork/identity.ts
stamped=(apps/desktop/package.json apps/server/package.json apps/web/package.json packages/contracts/package.json "$identity")
work=$(mktemp -d)
cleanup() { git checkout -- "${stamped[@]}"; rm -rf "$work"; }
trap cleanup EXIT

vp i
node scripts/update-release-package-versions.ts "$version"
# The app is opened from Finder and never reads fork.env, so its own folders are
# written into its source for this build (restored by cleanup).
node -e '
const [file, home, profile] = process.argv.slice(1);
require("node:fs").writeFileSync(file, `// Fork: written by fork/scripts/build.sh from fork.env for one build.
export const FORK_DESKTOP_HOME_DIRNAME = ${JSON.stringify(home)};
export const FORK_DESKTOP_PROFILE_DIRNAME = ${JSON.stringify(profile)};
`);
' "$identity" "$desktop_home_dirname" "$desktop_package_name"
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

T3CODE_DESKTOP_PRODUCT_NAME="Julia" T3CODE_DESKTOP_APP_ID="$desktop_bundle_id" T3CODE_DESKTOP_PACKAGE_NAME="$desktop_package_name" \
  vp run dist:desktop:artifact --platform mac --target dmg --arch arm64 \
  --build-version "$version" --skip-build --output-dir "$out"
rm -f "$out"/*.blockmap "$out"/builder-debug.yml "$out"/*.dmg

# Linux x64, cross-built here: Node's single executable for linux-x64, the runtime packages'
# linux-x64 builds, and a static (musl) resource monitor linked by Rust's own lld, so no
# Linux C toolchain is needed. Needs `rustup target add x86_64-unknown-linux-musl` once.
CARGO_TARGET_X86_64_UNKNOWN_LINUX_MUSL_LINKER=rust-lld cargo +stable build --locked --release \
  --manifest-path native/resource-monitor/Cargo.toml --target x86_64-unknown-linux-musl
mkdir -p "$work/resource-monitor-linux/linux-x64"
cp native/resource-monitor/target/x86_64-unknown-linux-musl/release/t3-resource-monitor "$work/resource-monitor-linux/linux-x64/"
node apps/server/scripts/cli.ts build-exe --target linux-x64
node scripts/build-cli-archive.ts --platform linux --arch x64 --version "$version" \
  --resource-monitor-dir "$work/resource-monitor-linux" --output-dir "$out"
echo "$version" > "$out/VERSION"
ls -la "$out"
