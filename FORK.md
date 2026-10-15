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
the provider account whose tightest window (session, weekly or monthly) has the most left, then
the most session left, skipping limited accounts (a window under 5% left; an account at 99% of
its week is used up however fresh its session). The composer's existing machine chip shows the
choice as machine, account and that tightest window's percent left (`build-mac · alice · 88%`,
the design Owner picked from three on 2026-10-06), and its tooltip says why (`Auto chose build-mac:
most free memory · Claude alice (Pro): 88% left`). With no eligible machine the chip says so and sending asks you to pick one.
The account rule (`packages/shared/src/accountChoice.ts`) also runs in three places without the
machine rule: a new chat on a machine picked by hand moves off an account with no limit left,
once per draft (`useLimitedAccountSwitch`; picking that account again then sticks), a new task on
the phone moves its default model to the account Auto would use
(`apps/mobile/src/fork/autoAccount.ts`; a model picked in the draft stays), and a scheduled run
that starts a new thread moves off its saved account when that account is limited or signed out
(`apps/server/src/fork/accountWithLimitLeft.ts`). A scheduled task bound to a thread keeps the
thread's account.

**Codex default** (`apps/server/src/fork/codexDefaults.ts`). Codex's catalog marks GPT-6.1-Sol as
its default model and High as that model's default reasoning, so a new Codex chat on any
client starts there. A model you already chose for Codex in a draft is kept.

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

The model pickers say the same per account (`accountLimitSummary`): each model row in the
composer's picker ends with the account, plan and what is left
(`owner · Max 20x · 88% session · 61% week`, plus `% month` where reported), as do the provider rail's tooltips and the
composer model chip's tooltip. An account with no limit left says when it comes back instead
(`Max 20x · no limit left · back 3:40 PM`) and its icon in the rail is dimmed. On the phone the model sheet puts that line on each provider's
header and names the machine under its title (`Runs on build-mac`).

**Keep session windows running** (`apps/server/src/fork/usageWindowKeepAlive.ts`). A 5-hour
window starts with an account's first request, so an account idle past its reset loses those
hours. With Settings > General > Keep session windows running on, the server checks every
Claude and Codex account's session window from Usage > Limits and, when one has ended or none is
open, sends that account one tiny prompt (the one-shot branch-name generation on the provider's
default text model: Haiku, `gpt-6-luna`) and re-reads its limits. One prompt per login email, at
most every 10 minutes; accounts with no session window (Codex Pro Lite) or out of quota are
skipped. New logins are covered as soon as T3 sees them. Machine-local and off by default: turn it
on in one environment, since each one with it on pings. It replaces the standalone build-mac
`window-keepalive` script.

**Continue limited threads on another account** (`apps/server/src/fork/limitFailover.ts`). When a
turn stops on a usage limit, the server forks the thread into a new tab of the same chat (title
unchanged) and sends it "continue where you left off" on the first model in Settings > General >
Continue limited threads on another account whose provider has an account other than the limited
one with usage left, on the account Auto would pick. The default list is Claude Opus 5.5, then
GPT-6.1 Sol; on by default. Replacements must support the chosen model and options, and only
global or matching model-family quota windows determine its capacity. App-owned subagents retry
in their existing thread on a compatible account, bounded to three continuations within five
minutes. Stop cancels recovery. Parents with outstanding delegate results stay in place and
can receive those results on a compatible account, preserving task ownership.
The source thread's limit recovery is set off for a forked run, which marks
it handled and keeps auto-resume from also resuming it, and names the new tab (`continuedIn`), so
every client shows the source as finished instead of Limited and drops its recovery banner. Only a
thread no fallback could take reads Limited; with no account left anywhere, auto-resume and snooze
apply as before. The web "Usage limit reached" alert waits 12 seconds (past one sweep) and is
dropped if the thread moved meanwhile. Top-level failover runs inside upstream's usage-limit
sweep; child recovery is reserved when the failed turn commits. Both work with no client connected and
survives restarts; its command ids derive from the failed run, so a sweep cut short repeats the
same commands. The phone has the switch (Settings > Threads); the model list is on desktop and web.

**Machines** (`apps/web/src/fork/machines/`, `apps/mobile/src/fork/machines.tsx`,
`apps/server/src/fork/freeDisk.ts`). Usage > **Machines**, beside Limits, shows one card per paired
environment (respecting the page's environment filter) with its picture, name and three bars: CPU
%, memory used of total, disk used of total (the home volume). The numbers are each server's own
`server.getHostResources` snapshot, the same one Auto reads; the fork adds `totalDiskBytes` beside
`freeDiskBytes` (statfs `blocks * bsize`, optional, so an older server shows disk as not reported).
While the tab is open and the window visible (phone: screen focused and app in front) the client
asks each connected server again every 5 seconds, the server's own snapshot cache; otherwise it
asks nothing. A machine whose connection is down, or whose server stops answering, shows
`Offline · last seen 12m ago` from the newest snapshot time this client saw. The phone has the
same tab on its Usage screen, drawn from the same `machineCards.ts`.

Wherever a machine is picked, each machine also shows those numbers on one line
(`CPU 8% · Mem 9.6/16 GB · Disk 107/245 GB`, `machineSummary` in `machineCards.ts`): the
composer's machine menu (under each machine; the Auto option keeps its own text), Move to another
machine in the command palette, and the phone's new task Environment picker, each polled every 5
seconds only while that menu or screen is open (`MachineUsageLine.tsx`, `useMachineSummaries`).
The thread title menu is a native menu that cannot change once shown, so its Move items carry the
line as read when the menu opens (asked again unless the client holds a snapshot from the last
5 seconds).

**Move to another machine** (`apps/web/src/fork/moveThread/`, `apps/server/src/fork/moveThread.ts`).
Existing threads can change machine from **Run on** in the composer or thread details,
or **Thread settings → Run on** on the phone. The thread title menu and command palette
keep their move actions. Destinations need the same repository and subdirectory and the
current provider/model; sidebar grouping does not affect eligibility. Active turns must
finish or be stopped first. The transfer and handoff are shared in
`packages/client-runtime/src/threadMove.ts`. The
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

**Providers on every machine** (`apps/web/src/components/settings/addProviderEverywhere.tsx`,
`apps/server/src/fork/claudeAuth.ts`, `apps/server/src/fork/pairedOperatorScopes.ts`). Adding a
provider in Settings > Providers (any built-in driver, or a ChatGPT account for Codex) also adds it
to every other paired machine under the same instance ID; **Add to all machines** is on by default
and the toast names machines skipped as offline, without permission, or already having that ID.
ACP registry agents are prepared per machine and do not fan out. Only the entry is copied, so a
normal login is still per machine. Claude and Cursor can instead share one sign-in: Claude's
**Sign in** offers "Claude subscription, all machines", which runs `claude setup-token` in the
in-app terminal (the server holds the flow open until the client confirms, so the printed token
always reaches it) and the client saves the token as `CLAUDE_CODE_OAUTH_TOKEN` on every machine.
The Claude token and Cursor API key fields on a provider save and clear on every machine. Codex
cannot share: its refresh tokens are single use, so each machine signs in itself. Claude's
per-machine option runs `claude auth login --claudeai` with the instance's `CLAUDE_CONFIG_DIR`,
so no Claude account needs a shell either way. A client paired by link or QR
with run access (`orchestration:operate`) also gets every standard permission at read time, so
clients paired before `providers:manage` existed see the add and sign-in controls without pairing
again; read-only pairings, agent MCP tokens and CLI-issued sessions keep exactly their grant.

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
  silently). File-evidence answers carry `asOf`, the hub's state and per-machine `coverage`.
- Remote subagents (`remoteTasks.ts`): `delegate_task` takes an optional `machine` (label or
  environment id); omitted or this machine means T3's own local child. On another machine the
  child is an ordinary top-level thread (the orchestrator's parent/child records cannot span two
  databases) in the project with the same repository, in a fresh worktree of the parent
  checkout's base branch from origin, so the parent's uncommitted or unpushed work is not there.
  Model and modes inherit as for a local child, and the instance must exist there (instance ids
  match across the three Macs). Its task id is `fleet:<environmentId>:<threadId>`, which
  `task_status` and `task_cancel` route to the owning machine. When its first run ends, the
  child's machine posts the result to the parent's (`peer/task-result`), which wakes the parent
  thread like a local child's result, within the parent's own modes. Undelivered results wait in
  `~/.t3/userdata/fork-remote-tasks.json` and are retried every 30 s, so a restart or an offline
  parent only delays them; a parent that reads a terminal result with `task_status` or
  `mode: "wait"` acknowledges it instead. `orchestrator_capabilities` takes the same `machine` and
  lists that machine's providers and models (`peer/providers`) with the caller's own inheritance.
- Permissions: fleet servers authenticate each other with a shared secret in
  `~/.t3/userdata/fork-fleet.json` (mode 600, generated once on 2026-10-06, never in git). The
  source server vouches for the calling thread; the destination acts for it as a client whose
  ceiling is that thread's runtime mode, so T3's own rule ("the target may not run with broader
  modes than the caller") is enforced at the destination, and idempotency keys are namespaced per
  source thread. Any holder of the secret can speak for any machine; all three are Owner's.
- Acme meaning (`acmePaths.ts`): SKU manifests and schemas report their SKU, the deepline and
  rapidapi packages their provider; every other path stays unknown rather than guessed.
- No overlap alerts: nothing is ever sent into a thread. An earlier version had the hub steer
  overlap notes into both threads' turns whenever they changed the same file; it fired on overlaps
  nobody needed to act on (two branches adding an entry to the same `package.json`), so it was
  removed. Quiet, dismissible suggestions in web/desktop and mobile compare user goals and
  recent agent findings, not just shared files. A configured GPT-6-Luna or Haiku 5.5 judges
  conflicting intents and duplicate investigations in one shared check per repository.
  Unchanged evidence is free of new model calls; changed evidence is checked at most once
  per five minutes, with a fleet-wide cap of three attempts per ten minutes on the hub, low reasoning,
  and a 64,000-character input cap. Only viewed chats or explicit tool calls request checks. "Review with agent" only fills a draft; neither agent receives anything until
  the user sends it. Agents can check the same reasons with `t3_coordination_suggestions`;
  `t3_who_else` remains the separate raw file-evidence tool. Old servers may leave `fork-fleet-notices.json` and,
  on mac-a, `fork-fleet-alerts-state.json` behind; nothing reads them now.

**Settled threads in Azure** (`apps/server/src/fork/threadHistory/`,
`apps/web/src/fork/threadHistory/`, `apps/mobile/src/fork/ThreadHistoryNotice.tsx`). A thread that
is settled (`settledOverride = "settled"`) or archived, and not deleted, moves its history off the
machine a few seconds later (upstream's 5-second due-work scheduler): every event except its
`thread.*` events, its `message.updated` events, its `run.*` events and its `provider-session.*`
events, plus the projection rows those events wrote (nodes, turn items, tool output,
checkpoints...). Runs stay because a thread's status in every list comes from its latest run;
without them a finished thread showed the working spinner. Threads offloaded before 2026-10-14
get their run events back from their blob on the next sweep. On
mac-a on 2026-10-13 that is 473 MB of the settled threads' 499 MB of event JSON; the kept message
text is about 18 MB, so lists, titles and content search (`ThreadSearch`, which reads
`orchestration_v2_projection_messages`, used by the sidebar search, the phone and `t3_thread_search`)
still find the thread by any phrase in it. A content search over Azure would have to download every
blob per query. Attachments stay on disk (17 MB in all on mac-a).

- Offload uploads a gzip bundle to `<environment id>/<SHA-256 of thread id>/<time>.json.gz` (thread
  ids can pass Azure's 1,024-character name limit), downloads it and
  checks its SHA-256, then deletes locally in one transaction that checks the thread again. It
  never moves a thread with a running or queued turn, a waiting request or secret request, pending
  effects or background work, a message waiting to start, a scheduled usage-limit resume, an open
  fork of it (forks read their source's rows), an event type it does not know, or a row id another
  thread owns (Orchestrator reuses message ids). `fork_thread_history` keeps the pointer.
- Restore runs before every thread read and every command except metadata-only ones (visit, pin,
  rename, pull request sync, snooze, settle, archive, delete), from `ensureLegacyTranscript` in
  `ThreadManagementService`: opening, unsettling, unarchiving, sending, MCP `t3_thread_read` and the
  fleet's peer read all go through it. Events come back under new sequence numbers (so a client that
  cached the stub receives them) and their rows are rebuilt with the current projection code. A
  thread opened to read stays local until it is settled or archived again; each offload is a new
  blob, so re-settling restarts its 60 days.
- `fork.threadHistory` (stream RPC, read scope) reports `restoring`, `expired` or `unavailable`,
  shown in the composer's activity slot on web and desktop and above the composer on the phone.
  Expired (the blob is gone) leaves the stub readable; unavailable fails the read, so the client
  keeps retrying, and the notice has Retry.
- Retention: the lifecycle rule `t3-thread-history-60-days` on storage account `examplestorage`
  (resource group `example-rg`) deletes blobs 60 days after creation (prefix `t3-thread-history/`).
  The account's one lifecycle policy document also holds the Orchestrator backup rules
  (`orchestrator-backups/db/{hourly,weekly,monthly}/`, 7/28/31 days): change it by reading the policy,
  merging and writing it back, never by replacing it.
- Credentials: app registration `t3-thread-history` has only Storage Blob Data Contributor on
  container `t3-thread-history`; its client secret (expires 2027-10-14) is the JSON in Key Vault
  `example-vault` secret `example-secret`, read with the machine's own `az`
  login when first needed and kept only in memory. `t3-thread-history-test` / its `-test-credential`
  secret is the same for the test container. `T3CODE_THREAD_HISTORY_SECRET` picks another secret,
  `off` turns the feature off. A Mac without an `az` login offloads nothing.
- Disk: rows deleted inside SQLite free pages, not disk. `install-runtime.sh` switches the
  database to incremental vacuum once per machine, at a deploy (one `VACUUM` with the server
  stopped, 42 s for mac-a's 2.8 GB), and the server runs `PRAGMA incremental_vacuum` after each
  offload.

**Restarts keep background work** (`apps/server/src/fork/restartWake.ts`, `fork/scripts/live-work.sh`,
`fork/scripts/deploy-when-idle.sh`). A thread whose turn has ended can still have work running:
Claude subagents, background shells and Monitors, which report back by waking the thread. A T3
restart kills them, and upstream only tells the agent on the user's next message (#15604 stopped
waking settled threads because stale "running" rows under stopped sessions woke long-finished
ones). On 2026-10-14 two deploys and a restart on mac-a killed "Discuss Email with Chief of
Staff"'s subagents and nothing resumed them for an hour.

- Planned restarts wait. `live-work.sh` lists what a restart would cut off: runs that are working
  or about to start, the provider's background roster (shells, Monitors), running
  subagent/shell/tool items, and a wake turn Claude started for a finished task. Background work
  counts only while its provider session is live. A held queued message (after Stop, a provider
  failure or a restart) does not count: it waits for a person and survives a restart. Sending a
  message to that thread, from the user or over MCP, resumes the held queue, earliest message first;
  upstream starts the user's new message ahead and leaves the hold to anything an agent sends. `deploy-when-idle.sh` and the daily
  `pull-deploy.sh` install only when it prints nothing. There is no timeout: every 30 s check logs
  what it waits for and since when (`~/t3-fork/logs/deploy-when-idle-<sha>.log`). A dev server
  left running holds the deploy until it stops, which is the same rule. Restarts started by hand
  (`rollback.sh`, the in-app Update) do not wait.
- Any restart wakes the thread. When the server stops (SIGTERM from launchd or a deploy) it records
  each settled thread whose background work is live; after a crash, startup recovery does the same,
  since nothing marked the session stopped. The thread then gets a turn by itself whose prompt is
  the same note upstream used to prepend to the next message ("Note: the T3 server restarted, and
  this background work was cancelled before it finished. It will not report back: ..."), so the
  agent can relaunch or check on it. It runs as upstream's restart continuation does: once (its
  message id is derived from the run, and the next user turn no longer repeats the note), before a
  held queue, in the thread's own mode, and at most three automatic continuations in a row. A
  message the user sends first carries the note instead. Settled and snoozed threads are woken
  (sending unsettles them, as any message does); archived and deleted ones are not, since the user
  put them away. A run stopped with "stop only the main agent" is woken too, since its subagents
  were kept on purpose. It follows Settings > "Continue threads after server update" (on by default).

**Phone app** (`apps/mobile/src/fork/`, `fork/scripts/build-mobile.sh`,
`fork/scripts/artifacts-server.py`). An Android build, **T3 Code (Owner)**
(`com.example.julia`, the Nightly icon), installs beside the Play Store app and pairs with
the three servers like the official one. Where the phone has the matching screen it shows the
fork: machine names (server side, so any app shows them after pairing), machine pictures wherever
it draws an environment's machine glyph, Usage > Machines and the usage line in the new task
Environment picker (above), and on Usage > Limits the **Use now** and **Resets next**
marks per provider (the web fork's `buildAccountCards`, so phone and desktop always mark the same
account) beside the plan tier the servers already report (`Claude Max 20x`). Fleet awareness is
agent-side, so the phone sees it only in the agents' transcripts. Not on the phone, because it has
no matching screen: the Auto chip (the phone's new-thread flow has no machine balancing at all),
the large environment-list pictures (the phone's environment rows draw the glyph at 14 pt, and the picture keeps that
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

- `packages/contracts/src/resourceTelemetry.ts`: optional `freeDiskBytes` and `totalDiskBytes` on `HostResourcesSnapshot`.
- `apps/server/src/resourceTelemetry/HostResources.ts`: fills both from `fork/freeDisk.ts`.
- `apps/server/src/provider/ClaudeProvider.ts`: passes the Max tier into T3's plan label.
- `apps/server/src/environment/ServerEnvironment.ts`: the `environment-label` file wins over the computer name.
- `packages/contracts/src/settings.ts`: Auto (`loadBalancingEnabled`) on by default.
- `packages/contracts/src/settings.test.ts`: the test of that default.
- `packages/contracts/src/settings.ts` (again): `keepUsageWindowsOpen`, off by default.
- `apps/server/src/orchestration-v2/runtimeLayer.ts`: registers the session window keep-alive.
- `apps/web/src/components/settings/SettingsPanels.tsx`, `settingsSearch.ts`: its toggle.
- `packages/contracts/src/settings.ts` (again): `syncAutofixModelSelections`, the auto-fix chat's
  models in order (default Claude Opus, then GPT-6.1).
- `apps/web/src/components/settings/SettingsPanels.tsx`, `settingsSearch.ts` (again): its row
  (`ModelOrderSettings.tsx`) and restore entry.
- `packages/contracts/src/settings.ts` (again): `continueLimitedThreadsElsewhere` (on by default) and
  `limitFailoverModelSelections` (default Claude Opus 5.5, then GPT-6.1 Sol).
- `apps/server/src/orchestration-v2/UsageLimitRecoveryWorker.ts`: its sweep offers each newly
  limited thread to `fork/limitFailover.ts` first; `src/scheduling/Scheduler.integration.test.ts`
  mocks the provider registry the sweep now reads.
- `apps/web/src/components/settings/SettingsPanels.tsx`, `settingsSearch.ts` (again): its row
  (`LimitFailoverRow` in `ModelOrderSettings.tsx`) and restore entry.
- `apps/mobile/src/features/settings/SettingsThreadsRouteScreen.tsx`: its switch.
- `packages/contracts/src/orchestrationV2.ts`: `continuedIn` on the limit recovery record and update;
  `apps/server/src/orchestration-v2/Orchestrator.ts` keeps it across later recovery updates.
- `packages/client-runtime/src/state/models.ts`: `limitContinuedElsewhere` presents such a run as
  completed; `apps/web/src/components/ChatView.tsx` hides its recovery banner;
  `apps/web/src/components/ThreadNotificationCoordinator.tsx` delays the limit alert.
- `apps/web/src/components/ChatView.tsx`: Auto's candidates, rule and hook (replacing upstream's
  weighted balance), the Auto account, the Auto chip text and tooltip; the moved-thread banner.
- `apps/web/src/components/BranchToolbar.tsx`, `apps/web/src/components/BranchToolbarEnvironmentSelector.tsx`:
  an optional tooltip text for the Auto chip (`autoEnvironmentDetail`); each machine in their
  menus (the composer's combined Run on / Workspace menu and the machine-only select) shows its
  usage line (`MachineUsageLine`).
- `apps/web/src/components/settings/LoadBalancingSettings.tsx`: laptops show as Manual only by
  default; describes the fork rule.
- `apps/web/src/components/EnvironmentMachineIcon.tsx`: looks up a picture before T3's icon.
- `apps/web/src/components/settings/EnvironmentRow.tsx`: environment lists draw the picture
  large enough to read.
- `apps/web/src/components/usage/UsageLimits.tsx`: renders the by-account view.
- `apps/web/src/components/usage/UsagePage.tsx`, `usageShortcuts.ts`, `usagePagePreferences.ts`: the
  Machines tab (an option without a shortcut; period and refresh disabled as for Limits).
- `apps/web/src/components/settings/KeybindingsSettings.logic.ts`: skips a Usage option without a
  shortcut when ordering Usage bindings.
- `apps/web/src/hooks/useThreadActionMenu.ts`: adds the Move items to the thread menu (awaited,
  since they read each machine's usage as the menu opens).
- `packages/contracts/src/rpc.ts`, `packages/contracts/src/index.ts`: the `fork.moveReceive` RPC
  (schemas in `packages/contracts/src/forkMoveThread.ts`).
- `apps/server/src/auth/RpcAuthorization.ts`: `fork.moveReceive` needs the orchestration operate scope.
- `apps/server/src/ws.ts`: the `fork.moveReceive` handler (calls `fork/moveThread.ts`).
- `apps/web/src/components/CommandPalette.tsx`: the same Move choices in the command palette, each
  with its usage line as the description.
- `apps/desktop/src/main.ts`: imports `fork/keychain.ts` first (see Keychain).
- `apps/desktop/src/app/DesktopStatePaths.ts`: the fork app's state directory.
- `apps/desktop/src/app/DesktopUserData.ts`: the fork app's Electron profile directory.
- `scripts/build-desktop-artifact.ts`: app id, product name and package name from the environment.
- `apps/server/src/mcp/McpHttpServer.ts`: adds the fleet layer (toolkit, routes, publisher) to the MCP server.
- `packages/contracts/src/orchestratorMcp.ts`: optional `machine` on `delegate_task`, `machine` and
  `link` on its result.
- `apps/server/src/mcp/toolkits/orchestrator/handlers.ts`, `tools.ts`: `delegate_task`,
  `task_status` and `task_cancel` hand remote tasks to `fork/fleet/remoteTasks.ts`; the tool
  descriptions mention `machine`; `orchestrator_capabilities` takes a `machine` too.
- `apps/server/src/mcp/OrchestratorMcpService.ts`: exports `taskStatusForRun`.
- `apps/mobile/app.config.ts`: `withOwnerFork(config)` (identity and update URL, only with `T3CODE_MOBILE_OWNER=1`).
- `apps/mobile/src/components/EnvironmentMachineSymbol.tsx`: looks up a machine picture before T3's glyph.
- `apps/mobile/src/features/usage/UsageLimitsPooled.tsx`: the Use now / Resets next marks under each account.
- `apps/mobile/src/features/usage/UsageRouteScreen.tsx`: the Machines tab (no pull to refresh; it is live).
- `apps/mobile/src/features/threads/NewTaskContextPickerScreens.tsx`: the new task Environment
  picker's rows get the usage line as their subtitle.
- `packages/shared/package.json`: exports `./accountChoice`, the account rule the web, the phone and
  the server share.
- `apps/mobile/src/features/threads/new-task-flow-provider.tsx`: the default model goes through
  `withAutoAccount`.
- `apps/server/src/scheduledTasks/ScheduledTaskService.ts`: a new-thread run goes through
  `scheduledRunModelSelection`.
- `apps/web/src/components/ChatView.tsx` (again): `useLimitedAccountSwitch` outside Auto.
- `apps/web/src/components/chat/ModelPickerContent.tsx`, `ModelPickerSidebar.tsx`: dims limited
  instances in the rail.
- `apps/server/src/provider/CodexProvider.ts`: the Codex default model and effort from
  `fork/codexDefaults.ts`.
- `apps/server/src/auth/SessionStore.ts`: session scopes go through `fork/pairedOperatorScopes.ts`.
- `apps/server/src/provider/Drivers/ClaudeDriver.ts`: the Claude instance gets `fork/claudeAuth.ts`
  as its sign-in and advertises it.
- `apps/web/src/components/settings/AddProviderInstanceDialog.tsx`, `AddCodexAccountDialog.tsx`:
  the Add to all machines switch and the fan-out after a successful add.
- `apps/web/src/components/settings/AddProviderInstanceDialog.environment.test.tsx`: mocks the fan-out.
- `apps/server/src/orchestration-v2/ThreadManagementService.ts`: `ensureLegacyTranscript` also restores a
  settled thread's history (`fork/threadHistory`), given the command type when dispatching.
- `apps/server/src/orchestration-v2/runtimeLayer.ts`: provides `ThreadHistory` and registers its sweep.
- `packages/contracts/src/rpc.ts`, `index.ts`: the `fork.threadHistory` stream RPC
  (`forkThreadHistory.ts`); `apps/server/src/ws.ts`, `auth/RpcAuthorization.ts`,
  `observability/RpcInstrumentation.ts`: its handler, read scope and span kind.
- `packages/client-runtime/src/rpc/client.ts`, `state/server.ts`: its subscription atom.
- `apps/web/src/components/ChatView.tsx`: the history notice, in place of "Syncing messages" while
  it restores or fails; `apps/mobile/src/features/threads/ThreadDetailScreen.tsx`: the phone's notice.
- `apps/server/src/orchestration-v2/ProviderRuntimeRecoveryService.ts`: shutdown intent and crash
  recovery also queue a restart continuation for `fork/restartWake.ts`'s settled run;
  `RestartContinuation.ts` and `Orchestrator.ts` admit that continuation with the note as its prompt.
  Their tests (`RestartContinuation.test.ts`, `runtimeLayer.test.ts`,
  `testkit/OrchestratorReplayRestartBackgroundNote.integration.test.ts`) expect the wake;
  `testkit/ProviderReplayHarness.ts` gains `shutdownLikeServer` to close as the server does.

Commit series on `owner` (oldest first), one series per feature so each can be dropped or
proposed on its own: free disk + Auto (2 commits), pictures (1), Claude tier + Usage by account
(2; Usage reuses Auto's `chooseAutoAccount`), move to another machine (1; reuses Auto's rules),
machine names (1), fleet awareness (1), packaging (1), tooling (2), this file (1), then move over
the fleet instead of GitHub (1; the move feature now depends on fleet awareness), overlap alerts
(1), opening the moved thread once the client knows it (1), then the phone app: its identity (1),
pictures and account marks (1), sync and update serving (1), and its layout fix with this section (1),
then Machines (1; adds total disk to the free disk commit's field and owner), then usage in the
machine pickers (1), account limits in the model pickers (1), then Auto's account on the phone and
in scheduled runs (1; moves the account rule to `packages/shared`), then limited accounts on
desktop and the Codex default (1), then providers on every machine (1), then settled threads in
Azure (1).

## Sync, build, deploy

```
build-mac 05:00  com.example.t3code-fork.sync    fork/scripts/sync.sh
             fetch upstream tags -> rebase owner onto the newest v*-nightly.* tag
             -> fork/scripts/checks.sh (typecheck of contracts/web/server/desktop/scripts,
                lint of every file the fork touches, fork tests + tests beside touched files)
             -> fork/scripts/build.sh (server runtime archive + T3 Code (Owner).app)
             -> fork/scripts/build-mobile.sh build (phone update; an APK only on a new fingerprint)
             any of these fails -> fork/scripts/autofix.sh: an agent chat on build-mac fixes it,
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
             waits for the next day while live-work.sh reports anything
any Mac, on demand  com.example.t3code-fork.deploy-when-idle-<sha>  ~/t3-fork/deploy-when-idle.sh
             fork/scripts/deploy-when-idle.sh --schedule <release tag> installs that release
             as soon as live-work.sh reports nothing (checked every 30 s, logged), then
             removes itself; a newer release supersedes it
```

To ship a release to a Mac without waiting for 05:45, schedule it with
`fork/scripts/deploy-when-idle.sh --schedule owner-<version>-<sha>`. Do not copy an older
`~/t3-fork/deploy-when-idle-<sha>.sh`: those check runs only and restart over background work.
`install-runtime.sh` also refreshes `~/t3-fork/pull-deploy.sh` from the release it installs.

**Why build-mac and not a GitHub Action:** the desktop app must be built on macOS. GitHub's macOS
runners bill private-repo minutes at ten times the Linux rate, a daily ~10-minute build would
use most of the free allowance, and an Action cannot reach the Macs without putting a Tailscale
auth key in GitHub. build-mac is always on, already has the toolchain (`vp`, Rust, Node), builds in
about four minutes, and every Mac reaches GitHub with its own `gh` login. The MacBook has Remote
Login off, so a pull from each Mac replaces a push from build-mac. The large artifacts travel over
the tailnet from build-mac, not through GitHub: uploading them from build-mac failed about one time in
three on 2026-10-06 (broken pipe and TLS errors on 80-150 MB uploads).

**When the sync fails** (a rebase conflict, or a failed check, desktop build or phone build),
`fork/scripts/autofix.sh` hands it to an agent chat in T3 Code on build-mac (full access; the first
model in Settings > General > "Fork sync auto-fix models" whose provider has an account with
usage left, on the account Auto would pick; default Claude Opus, then GPT-6.1; see
`apps/server/src/fork/autofixAccount.ts`), titled "Fork sync auto-fix: <upstream ref>", so it appears in Owner's app
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

Fork versions are `<upstream nightly>.owner.<build epoch seconds>+owner.<sha>`. The numeric
prerelease revision orders fork builds of one nightly; the hash is only artifact identity.
The existing stock launcher understands this ordering without changing its binary or privacy
grants. A newer upstream nightly still sorts after every fork build of the previous nightly.
The fork remains outside upstream's nightly-channel pattern, so it reports the stable channel.

Fork runtime downloads use build-mac's tailnet artifact server and exact-version directories,
including checksum verification; `T3CODE_RELEASE_BASE_URL` still overrides the source for an
explicit mirror. The built-in **Update all** can then synchronize older servers with the
client's fork version. Builds using the old `<upstream nightly>+owner.<sha>` scheme need one
bootstrap deploy through `pull-deploy.sh` on each Mac, then a relaunch of the updated desktop
app: their old code cannot fetch fork artifacts or order fork revisions correctly.

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
  full; limited = any window under 5% left (Claude warns at 99% of a week while the session is
  fresh, and a turn needs more than 1%). Accounts reporting no usage rank last.
- Applying the account: when Auto resolves, the composer's model selection moves to the chosen
  instance with the same model (T3's own model-select path), once per machine/driver/choice, so
  picking another account by hand in the model picker sticks until Auto's answer changes. To
  choose both machine and account by hand, pick the machine; Auto then stays out.
- Running threads per machine: thread shells in `preparing`, `starting` or `running`, from the
  shell stream every client already has.
- Machines: memory used = total - T3's available memory (see Deviations); disk used = total - free
  on the home volume, which on APFS counts every volume in the container, as Finder does. Memory
  is shown in binary units and disk in decimal ones, as Activity Monitor and Finder do. The web and
  phone hooks are two small copies because a file under `apps/web` imported by the phone must not
  import `@effect/atom-react` (a second copy would miss the phone's registry context).
- Disk: worktree `node_modules` are APFS clones that share blocks, so `du` and Finder count each
  copy in full (about 250 GB for 70 GB actually used on mac-a on 2026-10-14).
  `fork/scripts/disk-usage.py <dirs> --context <other dirs> --skip-git` reports what a folder really
  uses and what deleting it would free. Never run `pnpm store prune` here: with clones every store
  file has one link, so prune deletes the whole store and the next install downloads it again.

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
- Usage > Machines has no keyboard shortcut (Cost, Tokens and Limits have C, T, L): one would need
  a new keybinding command in contracts and shared defaults for a tab Owner opens by clicking.
- A machine's "last seen" is what this client saw since it started; a machine already offline when
  the app opens shows `not seen since the app opened`. No server keeps a history to ask.
- The moved-thread banner is remembered by the client that did the move; other clients see the
  source thread's "Moved to ..." title.
- Fleet lifecycle changes are noticed through the domain event stream only as a trigger to
  rebuild from projections; T3 has no lifecycle-only subscription, so the fork filters the event
  types itself. A Claude read-only (Supervised) thread does not pre-approve the fleet tools; T3's
  read-only allowlist is upstream code the fork leaves alone.
- Usage in the machine pickers (Owner, 2026-10-06: "show the usage details when deciding what
  machine to put the code on") was read as: wherever a machine is picked for a thread, each
  machine shows its live CPU, memory and disk from the Machines tab's own data and formatting.
  The Auto option keeps its "why" text and gets no line of its own. The thread title menu is
  native (Electron), so its Move items show the reading taken as it opens instead of a live one;
  opening it waits for that reading (a fresh sample takes the server about 200 ms of CPU
  measuring, at most the existing 5-second query timeout for a server that does not answer).
