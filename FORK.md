# Owner's T3 Code fork

A private fork of [pingdotgg/t3code](https://github.com/pingdotgg/t3code), nightly channel, at
`owner/t3code` branch `owner`. It adds five features and runs on Owner's three Macs (MacBook
`laptop-host`, `mac-a-host` = mac-a, `build-mac-host` = build-mac). The branch is
always "the newest upstream nightly tag plus a short series of fork commits", rebased daily.

## Features

**Auto placement** (`apps/web/src/fork/autoPlacement/`, `apps/server/src/fork/freeDisk.ts`).
New threads default to Auto. Auto picks the machine (eligible: connected, has the project,
provider usable, Auto preference not "Manual only"; laptops stay out until their preference is
set) by most available memory, then fewest running threads, then most free disk. It then picks
the provider account with the most session (5-hour) usage left, weekly breaking ties, skipping
limited accounts. The composer's existing machine chip shows the choice as machine, account and
session left (`build-mac · alice · 88%`, the design Owner picked from three on 2026-10-06), and
its tooltip says why (`Auto chose build-mac: most free memory · Claude alice (Pro): 88% session
left`). With no eligible machine the chip says so and sending asks you to pick one.

**Machine pictures** (`apps/web/src/fork/machinePictures/`). MacBook Pro 16 (space black) and
Mac mini product pictures wherever T3 draws a laptop or Mac mini environment icon (environment
lists, icon picker, composer, sidebar), bundled in the app; environment lists draw them large
enough to read.

**Usage by account** (`apps/web/src/fork/usageByAccount/`, `apps/server/src/fork/claudePlanTier.ts`).
Usage > Limits shows one card per subscription account (the same login seen through several
machines is one card), titled by the login with the plan and tier (`Claude owner · Max 20x`),
each with its own windows, remaining % and reset time. **Use now** marks the account Auto would
pick for that provider (the same `chooseAutoAccount`). **Resets next** marks the account whose
session window resets soonest, with the countdown: simply the soonest future session reset per
provider, no threshold. Plans come from the providers' own data: Codex's `planType` (from the
ChatGPT id token) as T3 already reads it, and for Claude the SDK's `Claude Max` plus the
rate-limit tier (`default_claude_max_20x`) in Claude Code's own profile file `.claude.json` (no
credentials). An unknown tier shows the plan without one.

**Move to another machine** (`apps/web/src/fork/moveThread/`, `apps/server/src/fork/moveThread.ts`).
The thread title menu has **Move to another machine**, and the command palette **Move thread to
another machine...**, both listing the machines that have the project, Auto's pick first. The
branch travels machine to machine over the fleet channel (below), never through GitHub or any
other git remote, in every direction, MacBook included:

```
client ── fork.moveReceive (WS RPC) ──▶ target server
target ── POST <source>/fork/fleet/move/pack  {worktree, branch, the target's ref tips} ──▶ source
source: git add -A; commit "WIP: move to <machine>" (--no-verify) if anything is uncommitted;
        answer with `git bundle` of the branch minus every commit the target already has
target: git bundle unbundle into the project checkout (no ref changes); branch name = the
        source's, or <branch>-2, -3... when the target already has that branch
client: start a thread on the target in a new worktree on that branch from the moved commit
```

The new thread runs on the same model and the account Auto would use there.
Its first message carries the conversation: the original request plus the most recent messages
within T3's portable-handoff budget (16,000 bytes, `T3CODE_CONTEXT_HANDOFF_TOKEN_CAP`'s
default). The app opens the new thread once the target's thread list has it (a thread route
whose thread is unknown redirects to an empty new draft). The source thread is renamed
`Moved to <machine> · <title>`, settled, and shows a
banner with **Open**. Threads that are working, or that run in the project checkout instead of
their own worktree branch, are refused (the source server checks too), so a shared branch such as
main is never committed to. A move needs the fleet hub's index to find the source machine's URL;
the uncommitted work arrives on the target committed, as the latest commit.

**Machine names** (`apps/server/src/fork/environmentLabel.ts`). A one-line file
`~/.t3/userdata/environment-label` names the environment for every client (`MacBook`, `mac-a`,
`build-mac`), instead of the computer name ("Mac Mini"). Clients store the name when they
pair, so a client paired before the file existed keeps the old name until it is paired again.

**Fleet awareness** (`apps/server/src/fork/fleet/`). Agents can see what agents on the other
machines are doing. Each server rebuilds a snapshot of its own threads and checkouts from its
projections (never from the live-tail event stream, so a restart or reconnect always yields a
full snapshot, under a new incarnation id) and publishes it to an in-memory index on mac-a, the
hub. Authority stays with the owning server; if mac-a is down, the tools answer from the local
server plus the last index seen and say so in `coverage`, and nothing else is affected.

```
MacBook ─┐ full snapshot every heartbeat,      ┌──────── mac-a hub (in memory) ────────┐
mac-a ───┼─ and at once on lifecycle change ──▶│ latest snapshot per environment       │
build-mac ───┘   POST /fork/fleet/hub/publish      │ stale after 3 missed heartbeats       │
                                               └───────────────────────────────────────┘
tool on any server ── GET hub/index ─▶ overlaps computed locally, own snapshot substituted
t3_fleet_thread_read/send ─────────── POST <owner>/fork/fleet/peer/{read,send}
```

A record keeps four things apart: declared intent (keys published with `t3_work_publish`, read or
write), observed changes (paths in the thread's checkout: committed against its real base, which
is the default remote branch or a local branch it is stacked on, plus staged, unstaged and
untracked non-ignored files, with renames and deletes; one scan per checkout, shared by the
threads in it), lifecycle (running, idle, settled, archived) and freshness (the heartbeat the hub
received, the last successful scan, the thread's last activity). Identity is the thread's
environment and thread id plus the repository's canonical key; paths are repository-relative.

- Timing: a heartbeat every 10 s republishes the full snapshot after rescanning the checkouts of
  active threads; lifecycle events (run created/updated, thread created, archived, settled,
  deleted, renamed) trigger an immediate rebuild and publish, and a turn ending rescans that
  thread's checkout first. Measured on mac-a's Acme worktree: `git status -uall` 22 ms, base diff
  7 ms, ref listing 7 ms, so about 36 ms per checkout once the base is cached (about 100 ms more
  when HEAD or a branch tip moved). Six active checkouts cost about 0.2 s of one core per 10 s.
  Records turn stale after three missed heartbeats (30 s) and are never deleted for being absent;
  a complete snapshot drops what it no longer lists (deleted threads, removed worktrees), an
  incomplete one only adds, and a failed scan keeps the last good evidence with `scanError`.
  One heartbeat is also the limit for one git command and for every fleet HTTP call.
- Tools (one toolkit, same pattern as T3's own): `t3_fleet_list`, `t3_who_else`,
  `t3_work_publish` (replaces the caller's declared intents and returns overlaps in the same
  call), `t3_fleet_thread_read` (fetched from the owning server, T3's paging) and
  `t3_fleet_thread_send` (auto, queue or steer; no restart across machines; `idempotencyKey`
  required; a timeout or lost answer comes back as `outcome: "unknown"` and is never retried
  silently). Every answer carries `asOf`, the hub's state and per-machine `coverage`.
- Permissions: fleet servers authenticate each other with a shared secret in
  `~/.t3/userdata/fork-fleet.json` (mode 600, generated once on 2026-10-06, never in git). The
  source server vouches for the calling thread; the destination acts for it as a client whose
  ceiling is that thread's runtime mode, so T3's own rule ("the target may not run with broader
  modes than the caller") is enforced at the destination, and idempotency keys are namespaced per
  source thread. Any holder of the secret can speak for any machine; all three are Owner's.
- Acme meaning (`acmePaths.ts`): SKU manifests and schemas report their SKU, the deepline and
  rapidapi packages their provider; every other path stays unknown rather than guessed.
- Overlap alerts (`alerts.ts`, `alertHub.ts`, `notices.ts`): after every accepted publish the hub
  looks up the publishing machine's active threads in its index (the `t3_who_else` lookup) and
  notes each overlap to both threads. It **interrupts** (steers the running turn, T3's own steer)
  only when both threads are running, both machines are fresh, and both write the exact same file
  (observed in the checkout, or declared write on that path). Every other overlap (one side idle,
  a declared directory or a read, a stale machine) is a **passive note**: the owning server keeps
  it in `~/.t3/userdata/fork-fleet-notices.json` and steers it into the thread's next turn (a note
  that arrives mid-turn waits for the turn after; nothing ever starts a turn). Each direction of a
  pair is told once per file set: again only when the set of paths changes or the same set
  escalates to an interrupt; when the overlap ends a waiting note is withdrawn. Every note names
  the other chat, its machine and link, each file with declared/observed evidence, the data's
  time and every machine's heartbeat age. Notes only: nothing is stopped, merged or redirected.
  The hub keeps who-was-told in `fork-fleet-alerts-state.json` and logs every decision (notify,
  defer for a stale machine, withdraw, delivery outcome) to `~/.t3/userdata/logs/fork-fleet-alerts.jsonl`
  on mac-a. No locks, agent-to-agent protocol or transcript copying.

  ```
  publish ─▶ hub: decideAlerts(index, state) ─▶ POST <owner>/fork/fleet/notice
                                                 interrupt: steer now (no running turn: wait)
                                                 passive:   wait for the next turn, then steer
                                                 withdraw:  drop the waiting note
  ```

**Phone app** (`apps/mobile/src/fork/`, `fork/scripts/build-mobile.sh`,
`fork/scripts/artifacts-server.py`). An Android build, **T3 Code (Owner)**
(`com.example.julia`, the Nightly icon), installs beside the Play Store app and pairs with
the three servers like the official one. Where the phone has the matching screen it shows the
fork: machine names (server side, so any app shows them after pairing), machine pictures wherever
it draws an environment's machine glyph, and on Usage > Limits the **Use now** and **Resets next**
marks per provider (the web fork's `buildAccountCards`, so phone and desktop always mark the same
account) beside the plan tier the servers already report (`Claude Max 20x`). Fleet awareness is
agent-side, so the phone sees it only in the agents' transcripts. Not on the phone, because it has
no matching screen: the Auto chip (the phone's new-thread flow has no machine balancing at all),
Move to another machine (no such item in its thread menu), and the large environment-list
pictures (the phone's environment rows draw the glyph at 14 pt, and the picture keeps that
height). No push notifications (the fork build has no Firebase project) and no T3 Connect (no
Clerk keys); pairing is direct over the tailnet.

The phone stays current without reinstalling. The app is Expo with `expo-updates`, and its runtime
version is the native fingerprint (`runtimeVersion.policy: fingerprint` in `app.config.ts`), so a
JavaScript-only change can be delivered over the air to every binary with the same native code,
and a native change cannot. The fork serves the Expo Updates protocol itself from build-mac instead of
EAS (no Expo account, nothing leaves the tailnet):

```
sync.sh ─▶ build-mobile.sh build: runtime = fingerprint of apps/mobile (expo-updates CLI)
           APK for that runtime already published? no ─▶ expo prebuild + gradle assembleRelease
                                                         (arm64 only), signed with the fork key
           always ─▶ expo export (Hermes bundle + assets) + manifest.json (id = hash of the files)
        ─▶ build-mobile.sh publish ─▶ ~/t3-fork/out/mobile/android/<runtime>/
                                       updates/<id>/..., manifest.json (written last), *.apk
phone, every launch ── GET /mobile/manifest  (expo-platform, expo-runtime-version headers) ──▶
        artifacts-server.py: that runtime's manifest.json, or 204 = no update
        newer id ─▶ download in the background; T3's own update flow applies it at the next
        backgrounding (or asks, if the app stays in front)
```

On a day whose upstream nightly changes native code the fingerprint changes: the sync builds a new
APK (Gradle took 7 minutes cold on build-mac and 3m20s with its cache, on 2026-10-06; a
JavaScript-only update is an export of about a minute), the installed app
keeps its last update, and the sync opens (or comments on) the issue **"Install the new phone app
build"** on `owner/t3code` with the link. Owner taps it once on the phone; the APK is signed with
the same key, so it installs over the old one and keeps the pairings.

- Install link (tailnet only): `https://build-mac-host.example.ts.net:8444/mobile/T3-Code-Owner.apk`
  (Android asks once to allow installs from the browser). Pair: on a Mac, `t3 pair` (minis) or
  `t3 pair --tailscale` (MacBook), then in the app Settings > Environments > + : host
  `https://<host>.example.ts.net`, the code is the `token=` part of the printed link (or scan
  the QR with the camera button).
- Signing key: `~/t3-fork/keys/julia-fork-release.jks` (PKCS12, alias `julia-fork`) and its
  password file `julia-fork-release.pass`, both mode 600 in a 700 directory on build-mac, made
  2026-10-06, never in git. Losing it means every later APK needs an uninstall first (Android
  refuses a different key), which loses the app's pairings. Back it up if build-mac is ever rebuilt.
- Toolchain on build-mac (no Homebrew there): Temurin JDK 21 in `~/t3-fork/toolchain/jdk21`, Android
  SDK in `~/Library/Android/sdk` (cmdline-tools, platform-tools, platforms 36 and 37.0,
  build-tools 36/37, NDK 27.1.12297006, CMake 3.22.1; the versions React Native's
  `libs.versions.toml` pins).
- Manual: `fork/scripts/build-mobile.sh build <version> <out> ~/t3-fork/out/mobile` then
  `fork/scripts/build-mobile.sh publish <out> ~/t3-fork/out/mobile`.

**Packaging** (`apps/desktop/src/fork/`, `fork/scripts/`). The desktop app is
**T3 Code (Owner)** (`com.example.julia`) with its own profile
(`~/Library/Application Support/julia-fork`) and state (`~/.t3-owner-app`), no keychain use,
and no update feed.

## Upstream files touched

Everything else lives in `fork/`, `FORK.md`, and the `fork/` directories under `apps/`. Each
upstream edit is a hook (an import plus a call), marked `Fork (Owner)` where it is not obvious.

```
git diff --stat <upstream-tag>...owner -- . ':(exclude)FORK.md' ':(exclude)fork/**' ':(glob,exclude)apps/*/src/fork/**'
```

- `packages/contracts/src/resourceTelemetry.ts`: optional `freeDiskBytes` on `HostResourcesSnapshot`.
- `apps/server/src/resourceTelemetry/HostResources.ts`: fills `freeDiskBytes` from `fork/freeDisk.ts`.
- `apps/server/src/provider/ClaudeProvider.ts`: passes the Max tier into T3's plan label.
- `apps/server/src/environment/ServerEnvironment.ts`: the `environment-label` file wins over the computer name.
- `packages/contracts/src/settings.ts`: Auto (`loadBalancingEnabled`) on by default.
- `packages/contracts/src/settings.test.ts`: the test of that default.
- `apps/web/src/components/ChatView.tsx`: Auto's candidates, rule and hook (replacing upstream's
  weighted balance), the Auto account, the Auto chip text and tooltip; the moved-thread banner.
- `apps/web/src/components/BranchToolbar.tsx`, `apps/web/src/components/BranchToolbarEnvironmentSelector.tsx`:
  an optional tooltip text for the Auto chip (`autoEnvironmentDetail`).
- `apps/web/src/components/settings/LoadBalancingSettings.tsx`: laptops show as Manual only by
  default; describes the fork rule.
- `apps/web/src/components/EnvironmentMachineIcon.tsx`: looks up a picture before T3's icon.
- `apps/web/src/components/settings/EnvironmentRow.tsx`: environment lists draw the picture
  large enough to read.
- `apps/web/src/components/usage/UsageLimits.tsx`: renders the by-account view.
- `apps/web/src/hooks/useThreadActionMenu.ts`: adds the Move items to the thread menu.
- `packages/contracts/src/rpc.ts`, `packages/contracts/src/index.ts`: the `fork.moveReceive` RPC
  (schemas in `packages/contracts/src/forkMoveThread.ts`).
- `apps/server/src/auth/RpcAuthorization.ts`: `fork.moveReceive` needs the orchestration operate scope.
- `apps/server/src/ws.ts`: the `fork.moveReceive` handler (calls `fork/moveThread.ts`).
- `apps/web/src/components/CommandPalette.tsx`: the same Move choices in the command palette.
- `apps/desktop/src/main.ts`: imports `fork/keychain.ts` first (see Keychain).
- `apps/desktop/src/app/DesktopStatePaths.ts`: the fork app's state directory.
- `apps/desktop/src/app/DesktopUserData.ts`: the fork app's Electron profile directory.
- `scripts/build-desktop-artifact.ts`: app id, product name and package name from the environment.
- `apps/server/src/mcp/McpHttpServer.ts`: adds the fleet layer (toolkit, routes, publisher) to the MCP server.
- `apps/mobile/app.config.ts`: `withOwnerFork(config)` (identity and update URL, only with `T3CODE_MOBILE_OWNER=1`).
- `apps/mobile/src/components/EnvironmentMachineSymbol.tsx`: looks up a machine picture before T3's glyph.
- `apps/mobile/src/features/usage/UsageLimitsPooled.tsx`: the Use now / Resets next marks under each account.

Commit series on `owner` (oldest first), one series per feature so each can be dropped or
proposed on its own: free disk + Auto (2 commits), pictures (1), Claude tier + Usage by account
(2; Usage reuses Auto's `chooseAutoAccount`), move to another machine (1; reuses Auto's rules),
machine names (1), fleet awareness (1), packaging (1), tooling (2), this file (1), then move over
the fleet instead of GitHub (1; the move feature now depends on fleet awareness), overlap alerts
(1), opening the moved thread once the client knows it (1), then the phone app: its identity (1),
pictures and account marks (1), sync and update serving (1), and its layout fix with this section (1).

## Sync, build, deploy

```
build-mac 05:00  com.example.t3code-fork.sync    fork/scripts/sync.sh
             fetch upstream tags -> rebase owner onto the newest v*-nightly.* tag
             -> fork/scripts/checks.sh (typecheck of contracts/web/server/desktop/scripts,
                lint of every file the fork touches, fork tests + tests beside touched files)
             -> fork/scripts/build.sh (server runtime archive + T3 Code (Owner).app)
             -> fork/scripts/build-mobile.sh build (phone update; an APK only on a new fingerprint)
             any of these fails -> fork/scripts/autofix.sh: a Claude chat on build-mac fixes it,
                then the same checks and builds run again (see "When the sync fails")
             -> push owner, GitHub release owner-<version>-<sha> on owner/t3code
                (VERSION, SHA256SUMS, install scripts)
             -> build-mobile.sh publish (into ~/t3-fork/out/mobile); a new APK opens the issue
                "Install the new phone app build"
build-mac always com.example.t3code-fork.artifacts  ~/t3-fork/artifacts-server.py: ~/t3-fork/out served
             to the tailnet at https://build-mac-host.example.ts.net:8444 (Tailscale Serve
             -> 127.0.0.1:8790), plus /mobile/manifest for the phone
phone  every launch  T3 Code (Owner) asks /mobile/manifest for its runtime; downloads a newer
             update in the background and applies it at the next backgrounding
every Mac 05:45 com.example.t3code-fork.deploy ~/t3-fork/pull-deploy.sh
             newest release not yet running -> download its artifacts from build-mac, check
             SHA256SUMS -> install-runtime.sh (and install-desktop.sh on the MacBook);
             waits for the next day while any thread is working
```

**Why build-mac and not a GitHub Action:** the desktop app must be built on macOS. GitHub's macOS
runners bill private-repo minutes at ten times the Linux rate, a daily ~10-minute build would
use most of the free allowance, and an Action cannot reach the Macs without putting a Tailscale
auth key in GitHub. build-mac is always on, already has the toolchain (`vp`, Rust, Node), builds in
about four minutes, and every Mac reaches GitHub with its own `gh` login. The MacBook has Remote
Login off, so a pull from each Mac replaces a push from build-mac. The large artifacts travel over
the tailnet from build-mac, not through GitHub: uploading them from build-mac failed about one time in
three on 2026-10-06 (broken pipe and TLS errors on 80-150 MB uploads).

**When the sync fails** (a rebase conflict, or a failed check, desktop build or phone build),
`fork/scripts/autofix.sh` hands it to a Claude chat in T3 Code on build-mac (Claude owner,
Opus, full access), titled "Fork sync auto-fix: <upstream ref>", so it appears in Owner's app
under the project `t3code-fork` on build-mac. The chat works in the git worktree
`~/t3-fork/autofix/<stamp>/worktree` (branch `autofix/<stamp>`, started at origin/owner): it
rebases, resolves conflicts inside the fork commit being replayed, reruns `checks.sh`,
`build.sh` and `build-mobile.sh build`, and writes `~/t3-fork/autofix/<stamp>/report.md`
(`RESOLVED` or `UNRESOLVED`, what conflicted and how it was resolved). The sync waits for the
chat to finish, at most one hour (Owner's choice): after that it stops the chat's turn, as the
Stop button does, and treats it as unresolved. It then accepts its branch only if the report says `RESOLVED`, no rebase is left
in progress, the branch sits on the upstream ref, the fork's commit subjects are unchanged in
order and number (no "fix conflicts" commit), nothing under `fork/` changed, the fork's test
cases did not drop, and its `.skip`/`.only`/`@ts-ignore`/`@ts-expect-error`/lint-disable count
did not grow. It then runs the very same rebase check, checks and builds itself on that branch;
only if they pass does the normal push and release happen, and the release notes carry the
chat link and the agent's report (what conflicted, how it was resolved) for audit. The chat's
worktree is removed then; the chat itself stays in T3 Code.

**Where a failure shows up:** if the agent cannot get everything green, times out ("timed
out after 1 hour"), or its branch fails the guards or the rerun, nothing is released, so nothing deploys, and the job opens (or
comments on) the issue **"Fork sync failed"** on `owner/t3code` with the step, conflicting
files, the chat link, the agent's report and verdict, and the log tail. The agent's worktree is
kept in `~/t3-fork/autofix/<stamp>/worktree` to continue from. GitHub notifies Owner as the
repo owner; the MacBook's daily deploy job also raises a macOS notification while that issue is
open. The next successful sync closes it. Logs: `~/t3-fork/logs/` on each Mac.

Manual runs:

```
ssh build-mac 'zsh -lc "~/src/t3code-fork/fork/scripts/sync.sh"'                  # sync + publish now
ssh build-mac 'zsh -lc "~/src/t3code-fork/fork/scripts/sync.sh --dry-run"'        # rebase+check+build (+auto-fix) only
ssh build-mac 'zsh -lc "~/src/t3code-fork/fork/scripts/sync.sh --dry-run upstream/main"'
~/t3-fork/pull-deploy.sh                                                       # on any Mac: install now
```

Resolving a conflict by hand (after the auto-fix gave up): `cd ~/src/t3code-fork && git rebase
<tag>` on build-mac, fix the hook in the listed upstream file, `git rebase --continue`, then run
`fork/scripts/sync.sh`. `sync.sh --dry-run <ref> <seconds>` shortens the one-hour limit for a test; only a dry run
accepts it, and the 05:00 job passes no arguments. A dry run with a failure also starts a real auto-fix chat (it publishes
nothing and prints the issue body or release notes it would have used). `sync.sh` works on the
clone it lives in, so a test can run from a scratch clone whose `origin`/`upstream` are local.

### How a deploy works on one Mac

The LaunchAgent `com.t3tools.t3code.service` stays exactly as `t3 service install` wrote it:
it runs the **stock** runtime's `t3 __service-launcher`, which starts
`~/.t3/runtime/versions/<activeVersion>/t3 serve`. `install-runtime.sh` unpacks the fork
runtime beside the stock one, sets `activeVersion` in `~/.t3/runtime/service-state.json`,
restarts the agent, and waits for `/.well-known/t3/environment` to report the new version
(rolling back to the previous version if it does not within the launcher's own 120 s). Same
data dir, label, port 3773 and Tailscale Serve. Because the launcher binary does not change,
the MacBook's Full Disk Access grant for it keeps applying. It keeps the stock runtime and the
previous fork runtime on disk.

Fork versions are `<upstream nightly>+owner.<sha>`. Build metadata keeps semver order equal to
the upstream nightly, so the server never offers itself an "update" to a stock build, and the
version no longer matches upstream's nightly pattern, so the fork reports the stable channel.

### Rollback (one line per machine)

```
~/t3-fork/rollback.sh 0.0.46-nightly.20261005.2702
```

Run it on the MacBook, or `ssh mac-a '~/t3-fork/rollback.sh 0.0.46-nightly.20261005.2702'` and
the same for build-mac. It switches the service back to the stock runtime and stops the daily
deploy job. Desktop: quit T3 Code (Owner) and open T3 Code (Nightly), which still has its own
pairings. To resume the fork: `fork/scripts/install-jobs.sh deploy` then `~/t3-fork/pull-deploy.sh`.

### Building by hand

```
fork/scripts/build.sh <version> <out-dir>
fork/scripts/install-runtime.sh <out-dir>/t3-<version>-darwin-arm64.tar.gz
fork/scripts/install-desktop.sh <out-dir>/T3-Code-*-arm64.zip
fork/scripts/install-jobs.sh deploy        # every Mac;  on build-mac: sync artifacts deploy
```

Toolchain on the build Mac (build-mac): `vp` (`curl -fsSL https://vite.plus | VP_NODE_MANAGER=no bash`),
Rust stable via rustup, Node 24 (asdf), Xcode command line tools, `gh` logged in as owner.

## Keychain

Nothing the fork deploys asks for the keychain.

- **Desktop app.** Electron safe storage (which encrypts the saved pairings) keeps its key in a
  keychain item whose access list names the app by code hash: an app signed without an Apple
  Team ID cannot be named any other way, so every rebuild would prompt for the login password
  again (seen in securityd's log as "ACL partition mismatch: client cdhash"). The fork app
  starts Chromium with `--use-mock-keychain` (`apps/desktop/src/fork/keychain.ts`), so safe
  storage uses a fixed key and never reads the keychain. The trade-off: the fork app's saved
  pairings in `~/.t3-owner-app` are protected by file permissions only, the same as the server's
  own secrets in `~/.t3/userdata/secrets`.
- **Servers.** The T3 server reads one keychain item, the Cursor CLI login for Cursor usage, and
  only when "Cursor account usage" is turned on; it is off on all three Macs. Claude and Codex
  read their own credentials in their own processes, whose binaries the fork does not change.
- The prompt Owner saw on 2026-10-06 was the first fork build asking for the official app's
  `t3code Safe Storage`; the fork no longer uses that item or any other.

## Proposing upstream

Each series is independent of the packaging and tooling commits.

- **Free disk in host resources**: small, self-contained; propose as "report free disk with host
  resources" with a use in the load-balancing view.
- **Auto placement rule**: propose as an alternative load-balancing policy rather than a
  replacement: a setting "Balance by: free resources (current) / most free memory, then running
  threads, then free disk", plus "pick the account with the most session usage left" for
  providers with several instances. The rule functions are pure and tested; `useAutoPlacement`
  mirrors `useLoadBalancedEnvironment`.
- **Machine pictures**: upstream would want vector art, not Apple product photos (licensing).
  Propose the lookup hook (`machinePicture(kind)`) with optional user-supplied images per
  environment instead.
- **Usage by account**: propose as a "Group by: window / account" toggle on Limits; the flags
  reuse the account rule. The Claude tier label is a standalone fix ("show Max 5x/20x").
- **Move to another machine**: upstream tracks this as an open request (discussion #6874). The
  git half needs a server-to-server channel (the fork uses the fleet secret); upstream would want
  it over its own environment connections. Also missing is a server-to-server way to carry
  history: propose `thread.export` / `thread.import` so the target server runs its own portable
  handoff instead of the client-built first message.
- **Fleet awareness**: the record model, overlap rule and toolkit are generic; upstream would
  want the hub replaced by T3's own environment connections (each client already talks to every
  machine) rather than a fork-only shared secret, and the Acme path meanings left out.
- **Packaging**: `T3CODE_DESKTOP_APP_ID`/`_PRODUCT_NAME`/`_PACKAGE_NAME` overrides are useful to
  any fork; the profile split would need a build-time flag instead of the bundle-name check.

## Implementation notes

- Accounts: Auto ranks the chosen machine's enabled, installed, signed-in instances of the
  selected provider. Session = the window of kind `session`; weekly = the tightest window of kind
  `weekly` (model-specific weeklies included); a window whose reset time has passed counts as
  full; limited = any window with nothing left. Accounts reporting no usage rank last.
- Applying the account: when Auto resolves, the composer's model selection moves to the chosen
  instance with the same model (T3's own model-select path), once per machine/driver/choice, so
  picking another account by hand in the model picker sticks until Auto's answer changes. To
  choose both machine and account by hand, pick the machine; Auto then stays out.
- Running threads per machine: thread shells in `preparing`, `starting` or `running`, from the
  shell stream every client already has.

## Deviations

- Auto reuses upstream's load-balancing setting and per-machine preference instead of a new
  setting: "Manual only" excludes a machine; any other preference makes it eligible, and the
  Prefer/Normal/Less often levels have no further effect under the fork rule.
- "MacBook excluded unless enabled" is implemented as "laptops default to Manual only", since the
  environment's machine kind (`laptop`) is what T3 knows about the MacBook.
- Available memory is T3's own `server.getHostResources` figure (free + inactive + speculative
  pages on macOS), not Activity Monitor's "memory used" figure the Happier fork used.
- The desktop app's window title and menu read "T3 Code (Alpha)": T3 derives that label from the
  version, and the fork version's `+owner` suffix is outside upstream's nightly pattern. The app
  bundle, Dock and Finder name are "T3 Code (Owner)".
- The fork app was paired fresh with all three servers (Owner chose this over granting it the
  official app's keychain item), so it has its own pairing records on each server.
- Desktop updates install into /Applications without quitting a running app; the new build runs
  at the next launch.
- The phone app is Android only (Owner's phone); the iOS config is untouched. Its build is part
  of the sync, so a phone build failure holds back that day's server and desktop release too, the
  same rule as every other failed step. If that proves too strict, the phone step can report on
  the same issue without stopping the release.
- The phone app rides upstream's `preview` variant (Nightly icon and label) rather than a new
  variant, and overrides only name, package, scheme and update URL.
- The phone's pictures and account marks import the desktop's files across apps
  (`apps/web/src/fork/...`) rather than copying them, so there is one owner of each; the account
  rule's files import only types.
- Moving a thread carries the conversation as the new thread's first message, built by the client
  from the messages it has loaded, because T3's portable handoff runs on the server that owns the
  history and the target server has none of it. Reasoning, tool-call state and attachments do not
  move (as with T3's own handoffs); the work itself moves through git.
- The moved-thread banner is remembered by the client that did the move; other clients see the
  source thread's "Moved to ..." title.
- Fleet lifecycle changes are noticed through the domain event stream only as a trigger to
  rebuild from projections; T3 has no lifecycle-only subscription, so the fork filters the event
  types itself. A Claude read-only (Supervised) thread does not pre-approve the fleet tools; T3's
  read-only allowlist is upstream code the fork leaves alone.
