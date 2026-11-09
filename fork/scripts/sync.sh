#!/bin/bash
# Daily on the build Mac (LaunchAgent <job_label_prefix>.sync, install-jobs.sh):
# rebase the fork onto the newest upstream nightly tag, check, build, and
# publish a GitHub release on the fork's repository that every Mac's pull job installs,
# plus the phone app's update (build-mobile.sh) that the phone pulls itself.
# On a conflict or a failed step nothing is published (so nothing deploys) and
# the open "Fork sync failed" issue there gets the details.
#   fork/scripts/sync.sh            rebase, check, build, push, release
#   fork/scripts/sync.sh --dry-run [ref [autofix-limit-seconds]]
#       rebase (onto ref, default the newest nightly), check, build; push,
#       release and notify nothing, and put the branch back
set -uo pipefail
dry_run=false
onto=
# How long the auto-fix chat may work before it is stopped (one hour).
# Only a dry run can shorten it, for testing; the 05:00 job passes no arguments.
autofix_limit=3600
if [ "${1:-}" = "--dry-run" ]; then dry_run=true; onto=${2:-}; autofix_limit=${3:-$autofix_limit}; fi
repo=$(cd "$(dirname "$0")/../.." && pwd) # ~/src/t3code-fork
state="$HOME/t3-fork"
# fork_repo, fork_branch, version_label, mobile_apk_name; artifacts_url (install-jobs.sh
# artifacts); build_mac_url, this Mac's T3 Code server as the other machines reach it.
. "$repo/fork/scripts/fork.env" || exit 1
if ! $dry_run; then fork_require fork_repo artifacts_url || exit 1; fi
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
  git checkout -q "$fork_branch" 2>/dev/null
  git reset -q --hard "$before" 2>/dev/null
  notify_failure "$1"
  exit 1
}

cd "$repo" || exit 1
git fetch -q origin || fail "git fetch origin failed"
git fetch -q upstream --tags || fail "git fetch upstream failed"
git checkout -q "$fork_branch" && git reset -q --hard "origin/$fork_branch" || fail "could not check out origin/$fork_branch"
before=$(git rev-parse HEAD)
latest=$(git tag -l 'v*-nightly.*' | sort -V | tail -1)
[ -n "$onto" ] && latest=$onto
base=$(git describe --tags --abbrev=0 --match 'v*-nightly.*' HEAD)
current_release=$(gh release list -R "$fork_repo" --exclude-drafts --limit 1 --json tagName -q '.[0].tagName' 2>/dev/null)
echo "upstream latest $latest, fork based on $base, last release ${current_release:-none}"
# Upstream is checked once a day. Any other run, mostly an
# agent shipping a fork commit, builds on the fork's current base and starts no
# auto-fix chat: upstream cuts several nightlies a day, and each used to start a
# new hour-long chat. 23 h, not 24, so the 05:00 job's few seconds of drift never skip a day.
checked="$state/upstream-checked"
daily=true
if ! $dry_run && [ -f "$checked" ] && [ $(($(date +%s) - $(stat -f %m "$checked"))) -lt $((23 * 3600)) ]; then
  daily=false
  latest=$base
  echo "Upstream was checked $(date -r "$(stat -f %m "$checked")"); building on $base, no auto-fix."
fi
if ! $dry_run && $daily; then touch "$checked"; fi

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
    *-*) version="$upstream_version.$version_label.$fork_revision+$version_label.$sha" ;;
    *) version="$upstream_version-$version_label.$fork_revision+$version_label.$sha" ;; # dry-run against a stable ref
  esac
  tag="$version_label-$upstream_version-$sha"
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

# On a failure an agent chat on this Mac's T3 Code server gets the problem
# (autofix.sh). Its branch is published only if it passes autofix.sh's guards
# and then the very same prepare() above; otherwise the issue gets its report.
autofix_note=
if ! prepare; then
  $daily || fail "$problem

No auto-fix: upstream was already checked in the last 23 hours, so this run only rebuilt the fork on $base."
  echo "!! $problem"
  [ -n "${rebasing:-}" ] && git rebase --abort
  rebasing=
  git reset -q --hard "$before"
  autofix="$state/autofix/$(date +%Y%m%d-%H%M%S)"
  fork/scripts/autofix.sh "$latest" "$before" "$problem" "$log" "$autofix" "$autofix_limit"
  [ -f "$autofix/thread.json" ] &&
    thread_url="$build_mac_url/$(/usr/bin/python3 -c 'import json,sys; t=json.load(open(sys.argv[1])); print(t["environmentId"]+"/"+t["threadId"])' "$autofix/thread.json")"
  autofix_note="Auto-fix chat: ${thread_url:-no chat started}
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
  # The chat's folder is gone, so settle it (and any older one) rather than
  # leave a thread whose next message fails. Best effort: the release does not depend on it.
  node fork/scripts/autofix-thread.mjs settle || echo "!! Could not settle the auto-fix chats."
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
git push -q --force-with-lease="$fork_branch:$before" origin "$fork_branch" || fail "Push of the rebased branch failed."
# A release can only target a commit its repository has, so a separate fork_repo gets the branch too.
origin_repo=$(git remote get-url origin | sed -E 's#^(https://github\.com/|git@github\.com:)##; s#\.git$##')
if [ "$origin_repo" != "$fork_repo" ]; then
  git push -q --force "https://github.com/$fork_repo.git" "HEAD:refs/heads/$fork_branch" ||
    fail "Push of the rebased branch to $fork_repo failed."
fi
# Uploading the 80-150 MB artifacts from the build Mac to GitHub failed about one time in
# three (broken pipe / TLS errors, measured 2026-10-06), so the Macs download them
# from the build Mac's artifacts server (install-jobs.sh artifacts) and the release
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
  # any more, so the phone needs this APK installed once (it keeps its pairings).
  apk_title="Install the new phone app build"
  apk_body="Julia $version changed native code, so the phone needs this APK once; daily updates then resume over the air. On the phone: $artifacts_url/mobile/$mobile_apk_name.apk"
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
# The fork is current, so no earlier auto-fix chat needs attention any more.
node fork/scripts/autofix-thread.mjs settle || echo "!! Could not settle the auto-fix chats."
echo "Published $tag"
