#!/bin/bash
# Daily on the build Mac (build-mac, LaunchAgent com.example.t3code-fork.sync):
# rebase the fork onto the newest upstream nightly tag, check, build, and
# publish a GitHub release on owner/t3code that every Mac's pull job installs,
# plus the phone app's update (build-mobile.sh) that the phone pulls itself.
# On a conflict or a failed step nothing is published (so nothing deploys) and
# the open "Fork sync failed" issue on owner/t3code gets the details.
#   fork/scripts/sync.sh            rebase, check, build, push, release
#   fork/scripts/sync.sh --dry-run [ref [autofix-limit-seconds]]
#       rebase (onto ref, default the newest nightly), check, build; push,
#       release and notify nothing, and put the branch back
set -uo pipefail
dry_run=false
onto=
# How long the auto-fix chat may work before it is stopped (Owner's choice: one
# hour). Only a dry run can shorten it, for testing; the 05:00 job passes no arguments.
autofix_limit=3600
if [ "${1:-}" = "--dry-run" ]; then dry_run=true; onto=${2:-}; autofix_limit=${3:-$autofix_limit}; fi
repo=$(cd "$(dirname "$0")/../.." && pwd) # ~/src/t3code-fork
state="$HOME/t3-fork"
fork_repo="owner/t3code"
artifacts_url="https://build-mac-host.example.ts.net:8444" # com.example.t3code-fork.artifacts
t3_url="https://build-mac-host.example.ts.net" # this Mac's T3 Code server (Tailscale Serve)
mkdir -p "$state/logs" "$state/out"
log="$state/logs/sync-$(date +%Y%m%d-%H%M%S).log"
exec > >(tee -a "$log") 2>&1
export GODEBUG=netdns=go # gh misreads DNS failures as a bad token without it
export PATH="$HOME/.local/share/vite-plus/bin:$HOME/.cargo/bin:$HOME/.asdf/shims:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
echo "== fork sync $(date) dry_run=$dry_run"

notify_failure() {
  local title="Fork sync failed"
  local body
  local outcome="Nothing was published, so nothing was deployed; every Mac keeps running ${current_release:-the last release}."
  [ -n "${released:-}" ] && outcome="Release $tag is out and the Macs will deploy it; only the phone keeps its last update."
  body=$(printf '%s\n\nUpstream: %s\nFork head before sync: %s\nHost: %s\nLog: %s\n\n%s\n\nLast lines:\n```\n%s\n```\n' \
    "$1" "${latest:-unknown}" "${before:-unknown}" "$(hostname -s)" "$log" "$outcome" "$(tail -40 "$log")")
  if $dry_run; then printf '(dry run: no issue opened) The issue would get:\n%s\n' "$body"; return; fi
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

# Rebase onto $latest, check and build HEAD; on failure say why in $problem.
prepare() {
  local base fork_revision
  base=$(git describe --tags --abbrev=0 --match 'v*-nightly.*' HEAD)
  if [ "$latest" != "$base" ]; then
    rebasing=1
    if ! git rebase -q "$latest"; then
      conflicts=$(git status --porcelain | grep -E '^(UU|AA|DU|UD|AU|UA|DD) ' | sed 's/^.. /- /')
      problem="Rebase of the fork onto $latest stopped on a conflict in:
$conflicts"
      return 1
    fi
    rebasing=
  fi
  sha=$(git rev-parse --short=7 HEAD)
  upstream_version=$(git show HEAD:apps/server/package.json | /usr/bin/python3 -c 'import json,sys; print(json.load(sys.stdin)["version"])')
  case "$latest" in v*-nightly.*) upstream_version=${latest#v} ;; esac
  # A hash is artifact identity, not SemVer precedence. A numeric prerelease
  # revision lets the existing stock launcher order builds of one nightly.
  fork_revision=$(date +%s)
  case "$upstream_version" in
    *-*) version="$upstream_version.owner.$fork_revision+owner.$sha" ;;
    *) version="$upstream_version-owner.$fork_revision+owner.$sha" ;; # dry-run against a stable ref
  esac
  tag="owner-$upstream_version-$sha"
  if ! $dry_run && [ "$current_release" = "$tag" ]; then
    echo "Release $tag already published; nothing to do."
    exit 0
  fi
  fork/scripts/checks.sh "$latest" || { problem="Checks failed on $version (typecheck, lint, or tests)."; return 1; }
  out="$state/out/$version"
  rm -rf "$out"
  fork/scripts/build.sh "$version" "$out" || { problem="Build failed for $version."; return 1; }
  fork/scripts/build-mobile.sh build "$version" "$out" "$state/out/mobile" ||
    { problem="Phone app build failed for $version."; return 1; }
  tar -czf "$out/fork-scripts.tar.gz" -C fork/scripts .
}

# On a failure a Claude chat on this Mac's T3 Code server gets the problem
# (autofix.sh). Its branch is published only if it passes autofix.sh's guards
# and then the very same prepare() above; otherwise the issue gets its report.
autofix_note=
if ! prepare; then
  echo "!! $problem"
  [ -n "${rebasing:-}" ] && git rebase --abort
  rebasing=
  git reset -q --hard "$before"
  autofix="$state/autofix/$(date +%Y%m%d-%H%M%S)"
  fork/scripts/autofix.sh "$latest" "$before" "$problem" "$log" "$autofix" "$autofix_limit"
  [ -f "$autofix/thread.json" ] &&
    thread_url="$t3_url/$(/usr/bin/python3 -c 'import json,sys; t=json.load(open(sys.argv[1])); print(t["environmentId"]+"/"+t["threadId"])' "$autofix/thread.json")"
  autofix_note="Auto-fix by Claude: ${thread_url:-no chat started}
Verdict: $(cat "$autofix/verdict" 2>/dev/null)

$(cat "$autofix/report.md" 2>/dev/null)"
  first_problem=$problem
  if [ ! -f "$autofix/result" ]; then
    fail "$first_problem

$autofix_note

The agent's work is kept in $autofix/worktree. Resolve by hand: cd ~/src/t3code-fork && git rebase $latest, fix, then run fork/scripts/sync.sh."
  fi
  git reset -q --hard "$(cat "$autofix/result")"
  prepare || fail "$first_problem

$autofix_note

The agent's branch then failed the sync's own rerun: $problem
The agent's work is kept in $autofix/worktree."
  git worktree remove --force "$autofix/worktree" && git branch -q -D "autofix/$(basename "$autofix")"
  echo "Auto-fix accepted: $(git rev-parse --short HEAD) passed the same checks and build."
fi

notes="Fork of $latest. Version $version."
[ -n "$autofix_note" ] && notes="$notes

$autofix_note"
if $dry_run; then
  echo "Dry run OK: $version built in $out (not pushed, not released). Release notes would be:"
  echo "$notes"
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
    --title "$version" --notes "$notes" \
    "$out/VERSION" "$out/SHA256SUMS" "$out/fork-scripts.tar.gz" &&
    gh release edit "$tag" -R "$fork_repo" --draft=false --latest >/dev/null
}
publish || {
  gh release delete "$tag" -R "$fork_repo" --yes --cleanup-tag >/dev/null 2>&1
  fail "Publishing release $tag failed (the partial release was removed)."
}
released=1
fork/scripts/build-mobile.sh publish "$out" "$state/out/mobile" ||
  fail "Publishing the phone app update for $version failed."
if ls "$out"/mobile/*.apk >/dev/null 2>&1; then
  # A new native fingerprint: over-the-air updates cannot reach the installed app
  # any more, so Owner installs this APK once (it keeps his pairings).
  apk_title="Install the new phone app build"
  apk_body="T3 Code (Owner) $version changed native code, so the phone needs this APK once; daily updates then resume over the air. On the phone (on the tailnet): $artifacts_url/mobile/T3-Code-Owner.apk"
  apk_issue=$(gh issue list -R "$fork_repo" --state open --search "\"$apk_title\" in:title" --json number -q '.[0].number' 2>/dev/null)
  if [ -n "$apk_issue" ]; then
    gh issue comment "$apk_issue" -R "$fork_repo" --body "$apk_body" >/dev/null
  else
    gh issue create -R "$fork_repo" --title "$apk_title" --body "$apk_body" >/dev/null
  fi
fi
open_issue=$(gh issue list -R "$fork_repo" --state open --search "\"Fork sync failed\" in:title" --json number -q '.[0].number' 2>/dev/null)
[ -n "$open_issue" ] && gh issue close "$open_issue" -R "$fork_repo" --comment "Fixed: $tag published." >/dev/null
# Keep the output of this build and the one before it on disk.
ls -1dt "$state/out"/*/ 2>/dev/null | grep -v '/mobile/$' | tail -n +3 | xargs rm -rf
echo "Published $tag"
