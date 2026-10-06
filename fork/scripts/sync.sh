#!/bin/bash
# Daily on the build Mac (build-mac, LaunchAgent com.example.t3code-fork.sync):
# rebase the fork onto the newest upstream nightly tag, check, build, and
# publish a GitHub release on owner/t3code that every Mac's pull job installs.
# On a conflict or a failed step nothing is published (so nothing deploys) and
# the open "Fork sync failed" issue on owner/t3code gets the details.
#   fork/scripts/sync.sh            rebase, check, build, push, release
#   fork/scripts/sync.sh --dry-run [ref]
#       rebase (onto ref, default the newest nightly), check, build; push,
#       release and notify nothing, and put the branch back
set -uo pipefail
dry_run=false
onto=
if [ "${1:-}" = "--dry-run" ]; then dry_run=true; onto=${2:-}; fi
repo="$HOME/src/t3code-fork"
state="$HOME/t3-fork"
fork_repo="owner/t3code"
mkdir -p "$state/logs" "$state/out"
log="$state/logs/sync-$(date +%Y%m%d-%H%M%S).log"
exec > >(tee -a "$log") 2>&1
export GODEBUG=netdns=go # gh misreads DNS failures as a bad token without it
export PATH="$HOME/.local/share/vite-plus/bin:$HOME/.cargo/bin:$HOME/.asdf/shims:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
echo "== fork sync $(date) dry_run=$dry_run"

notify_failure() {
  local title="Fork sync failed"
  local body
  body=$(printf '%s\n\nUpstream: %s\nFork head before sync: %s\nHost: %s\nLog: %s\n\nNothing was published, so nothing was deployed; every Mac keeps running %s.\n\nLast lines:\n```\n%s\n```\n' \
    "$1" "${latest:-unknown}" "${before:-unknown}" "$(hostname -s)" "$log" "${current_release:-the last release}" "$(tail -40 "$log")")
  if $dry_run; then echo "(dry run: no issue opened)"; return; fi
  local number
  number=$(gh issue list -R "$fork_repo" --state open --search "\"$title\" in:title" --json number -q '.[0].number' 2>/dev/null)
  if [ -n "$number" ]; then
    gh issue comment "$number" -R "$fork_repo" --body "$body" >/dev/null
  else
    gh issue create -R "$fork_repo" --title "$title" --body "$body" >/dev/null
  fi
}
fail() {
  echo "!! $1"
  [ -n "${rebasing:-}" ] && git rebase --abort 2>/dev/null
  git checkout -q owner 2>/dev/null
  git reset -q --hard "$before" 2>/dev/null
  notify_failure "$1"
  exit 1
}

cd "$repo" || exit 1
git fetch -q origin || fail "git fetch origin failed"
git fetch -q upstream --tags || fail "git fetch upstream failed"
git checkout -q owner && git reset -q --hard origin/owner || fail "could not check out origin/owner"
before=$(git rev-parse HEAD)
latest=$(git tag -l 'v*-nightly.*' | sort -V | tail -1)
[ -n "$onto" ] && latest=$onto
base=$(git describe --tags --abbrev=0 --match 'v*-nightly.*' HEAD)
current_release=$(gh release list -R "$fork_repo" --exclude-drafts --limit 1 --json tagName -q '.[0].tagName' 2>/dev/null)
echo "upstream latest $latest, fork based on $base, last release ${current_release:-none}"

if [ "$latest" != "$base" ]; then
  rebasing=1
  if ! git rebase -q "$latest"; then
    conflicts=$(git status --porcelain | grep -E '^(UU|AA|DU|UD|AU|UA|DD) ' | sed 's/^.. /- /')
    fail "Rebase of the fork onto $latest stopped on a conflict in:
$conflicts

Resolve by hand: cd ~/src/t3code-fork && git rebase $latest, fix, then run fork/scripts/sync.sh."
  fi
  rebasing=
fi
sha=$(git rev-parse --short=7 HEAD)
upstream_version=$(git show HEAD:apps/server/package.json | /usr/bin/python3 -c 'import json,sys; print(json.load(sys.stdin)["version"])')
case "$latest" in v*-nightly.*) upstream_version=${latest#v} ;; esac
version="$upstream_version+owner.$sha"
tag="owner-$upstream_version-$sha"
if ! $dry_run && [ "$current_release" = "$tag" ]; then
  echo "Release $tag already published; nothing to do."
  exit 0
fi

fork/scripts/checks.sh "$latest" || fail "Checks failed on $version (typecheck, lint, or tests)."
out="$state/out/$version"
rm -rf "$out"
fork/scripts/build.sh "$version" "$out" || fail "Build failed for $version."
tar -czf "$out/fork-scripts.tar.gz" -C fork/scripts .

if $dry_run; then
  echo "Dry run OK: $version built in $out (not pushed, not released)."
  git reset -q --hard "$before"
  exit 0
fi
git push -q --force-with-lease=owner:"$before" origin owner || fail "Push of the rebased branch failed."
# Uploading the 80-150 MB artifacts from build-mac to GitHub failed about one time in
# three (broken pipe / TLS errors, measured 2026-10-06), so the Macs download them
# from build-mac over the tailnet (com.example.t3code-fork.artifacts) and the release
# only carries the version, checksums and install scripts. A draft first, so no
# Mac sees a release before its assets are in it.
(cd "$out" && shasum -a 256 t3-*-darwin-arm64.tar.gz T3-Code-*-arm64.zip > SHA256SUMS)
publish() {
  gh release create "$tag" -R "$fork_repo" --draft --target "$(git rev-parse HEAD)" \
    --title "$version" --notes "Fork of $latest. Version $version." \
    "$out/VERSION" "$out/SHA256SUMS" "$out/fork-scripts.tar.gz" &&
    gh release edit "$tag" -R "$fork_repo" --draft=false --latest >/dev/null
}
publish || {
  gh release delete "$tag" -R "$fork_repo" --yes --cleanup-tag >/dev/null 2>&1
  fail "Publishing release $tag failed (the partial release was removed)."
}
open_issue=$(gh issue list -R "$fork_repo" --state open --search "\"Fork sync failed\" in:title" --json number -q '.[0].number' 2>/dev/null)
[ -n "$open_issue" ] && gh issue close "$open_issue" -R "$fork_repo" --comment "Fixed: $tag published." >/dev/null
# Keep the output of this build and the one before it on disk.
ls -1dt "$state/out"/*/ 2>/dev/null | tail -n +3 | xargs rm -rf
echo "Published $tag"
