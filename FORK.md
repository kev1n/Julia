# Julia: a T3 Code fork

Julia is a fork of [pingdotgg/t3code](https://github.com/pingdotgg/t3code), nightly channel, for
people who run T3 Code on several Macs (and an Android phone) and want them to work as one fleet.
The fork branch is always "the newest upstream nightly tag plus a short series of fork commits",
rebased daily by a job on one of the Macs (the build Mac), which also builds and publishes the
release every other Mac installs. The rebased branch is force-pushed each day, so its history is
rewritten onto every upstream nightly: rebase your own work onto it rather than merging it.

Everything personal (your repository, host names, labels, signing keys, cloud accounts) lives in
local config files on your machines, never in the repository: see [Configuration](#configuration).
Without them the features that need them are off, never broken.

## Features

**Auto placement** (`apps/web/src/fork/autoPlacement/`, `apps/server/src/fork/freeDisk.ts`).
New threads default to Auto. Auto picks the machine (eligible: connected, has the project,
provider usable, Auto preference not "Manual only"; laptops stay out until their preference is
set) by most available memory, then fewest running threads, then most free disk. It then picks
the provider account whose tightest window (session, weekly or monthly) has the most left, then
the most session left, skipping limited accounts (a window under 5% left; an account at 99% of
its week is used up however fresh its session). The composer's existing machine chip shows the
choice as machine, account and that tightest window's percent left (`studio-b · alice · 88%`),
and its tooltip says why (`Auto chose studio-b: most free memory · Claude alice (Pro): 88% left`).
With no eligible machine the chip says so and sending asks you to pick one.
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
machines is one card), titled by the login with the plan and tier (`Claude alice · Max 20x`),
each with its own windows, remaining % and reset time. **Use now** marks the account Auto would
pick for that provider (the same `chooseAutoAccount`). **Resets next** marks the account whose
session window resets soonest, with the countdown: simply the soonest future session reset per
provider, no threshold. Plans come from the providers' own data: Codex's `planType` (from the
ChatGPT id token) as T3 already reads it, and for Claude the SDK's `Claude Max` plus the
rate-limit tier (`default_claude_max_20x`) in Claude Code's own profile file `.claude.json` (no
credentials). An unknown tier shows the plan without one.

The model pickers say the same per account (`accountLimitSummary`): each model row in the
composer's picker ends with the account, plan and what is left
(`alice · Max 20x · 88% session · 61% week`, plus `% month` where reported), as do the provider
rail's tooltips and the composer model chip's tooltip. An account with no limit left says when it
comes back instead (`Max 20x · no limit left · back 3:40 PM`) and its icon in the rail is dimmed.
On the phone the model sheet puts that line on each provider's header and names the machine under
its title (`Runs on studio-b`).

Several accounts per provider are easiest to run through a CLIProxyAPI pool; see README.md for
how a proxy-routed provider instance reports the pool's usage to Auto.

**Keep session windows running** (`apps/server/src/fork/usageWindowKeepAlive.ts`). A 5-hour
window starts with an account's first request, so an account idle past its reset loses those
hours. With Settings > General > Keep session windows running on, the server checks every
Claude and Codex account's session window from Usage > Limits and, when one has ended or none is
open, sends that account one tiny prompt (the one-shot branch-name generation on the provider's
default text model: Haiku, `gpt-6-luna`) and re-reads its limits. One prompt per login email, at
most every 10 minutes; accounts with no session window (Codex Pro Lite) or out of quota are
skipped. New logins are covered as soon as T3 sees them. Machine-local and off by default: turn it
on in one environment, since each one with it on pings.
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
every client shows the source as finished instead of Limited and drops its recovery banner. The
source names the new tab before that tab gets its first message, so nothing reading the source
(an external bridge that settles a finished run) sees it finished while its work runs unnamed; a
source naming a tab with no first message yet stays in the sweep, settled or not, until that
message is sent (until the limit resets), and auto-resume never resumes a source that names a
tab. Only a
thread no fallback could take reads Limited; with no account left anywhere, auto-resume and snooze
apply as before. The web "Usage limit reached" alert waits 12 seconds (past one sweep) and is
dropped if the thread moved meanwhile. Top-level failover runs inside upstream's usage-limit
sweep; child recovery is reserved when the failed turn commits. Both work with no client connected and
survives restarts; its command ids derive from the failed run, so a sweep cut short repeats the
same commands, except the tab's first message, which gets a new command id per attempt (a rejected
command id stays rejected) under one fixed message id. The phone has the switch (Settings > Threads); the model list is on desktop and web.

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
other git remote, in every direction, laptops included:

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
`~/.t3/userdata/environment-label` names the environment for every client (`laptop`, `studio-a`,
`studio-b`), instead of the computer name. Clients store the name when they
pair, so a client paired before the file existed keeps the old name until it is paired again.

**Pairings stay paired** (`apps/server/src/fork/sessionRenewal.ts`). Upstream ends every pairing
30 days after it was made, even while the client is connected, and a client has no way to renew
it, so each paired desktop or phone stops connecting on that day until it is paired again. On the
fork a pairing lasts until its client has not been connected for 30 days: each connect and
disconnect, and a connection still open at the deadline, restarts the 30 days. Sessions issued for less (T3
Connect's 1-hour tokens, `t3 auth session issue --ttl`) keep their fixed deadline. A client whose
pairing already ended pairs again with a new link through its environment's **Add route** in
Settings > Connections, which replaces the credential without disconnecting the environment.

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
full snapshot, under a new incarnation id) and publishes it to an in-memory index on one machine,
the hub. Authority stays with the owning server; if the hub is down, the tools answer from the local
server plus the last index seen and say so in `coverage`, and nothing else is affected.

```
laptop ───┐ full snapshot every heartbeat,      ┌──────── hub machine (in memory) ──────┐
studio-a ─┼─ and at once on lifecycle change ──▶│ latest snapshot per environment       │
studio-b ─┘   POST /fork/fleet/hub/publish      │ stale after 3 missed heartbeats       │
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
  thread's checkout first. Measured on a large repository's worktree: `git status -uall` 22 ms, base diff
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
  child is a subagent thread of the parent: its lineage names the parent (`remoteParentThreadId`
  on `thread.create`), so neither machine lists it as a top-level thread and every client nests
  it under the parent, which lives in the other machine's database (there is no subagent node in
  the parent's run; those records cannot span two databases). It runs in the project with the
  same repository, in a fresh worktree of the parent checkout's base branch from origin, so the
  parent's uncommitted or unpushed work is not there. Every 30 s, with result delivery, the
  child's machine asks each other machine directly (`peer/thread-lifecycles`, answered from that
  machine's own database, subagents included) about the parents of its idle remote children, and
  settles each child whose parent is settled or archived. A machine that does not answer changes
  nothing; the hub index only supplies addresses, never the parent's state. A user's follow-up to
  a remote child starts a run like any thread's (no task is recorded on a parent that is not in
  this database).
  Model and modes inherit as for a local child, and the instance must exist there (instance ids
  match across the machines). Its task id is `fleet:<environmentId>:<threadId>`, which
  `task_status` and `task_cancel` route to the owning machine. When its first run ends, the
  child's machine posts the result to the parent's (`peer/task-result`), which wakes the parent
  thread like a local child's result, within the parent's own modes. Undelivered results wait in
  `~/.t3/userdata/fork-remote-tasks.json` and are retried every 30 s, so a restart or an offline
  parent only delays them; a parent that reads a terminal result with `task_status` or
  `mode: "wait"` acknowledges it instead. `orchestrator_capabilities` takes the same `machine` and
  lists that machine's providers and models (`peer/providers`) with the caller's own inheritance.
- Permissions: fleet servers authenticate each other with a shared secret in
  `~/.t3/userdata/fork-fleet.json` (mode 600, never in git; see Configuration). The
  source server vouches for the calling thread; the destination acts for it as a client whose
  ceiling is that thread's runtime mode, so T3's own rule ("the target may not run with broader
  modes than the caller") is enforced at the destination, and idempotency keys are namespaced per
  source thread. Any holder of the secret can speak for any machine, so share it only among machines you own.
- Path meanings (`pathMeanings.ts`): optional `pathMeanings` rules in `fork-fleet.json` label a
  changed path in a matching repository (for example a manifest path as the product it defines);
  every path no rule matches stays unknown rather than guessed.
- No overlap alerts: nothing is ever sent into a thread. An earlier version had the hub steer
  overlap notes into both threads' turns whenever they changed the same file; it fired on overlaps
  nobody needed to act on (two branches adding an entry to the same `package.json`), so it was
  removed. A later model-judged "may be investigating the same bug" banner was removed too: it
  flagged chats the user already knew were the same work (a thread's own predecessor in another
  tab). `t3_who_else` is the only overlap tool, and it only answers when asked. Old servers may
  leave `fork-fleet-notices.json` and, on the hub, `fork-fleet-alerts-state.json` behind; nothing
  reads them now.

**Settled threads offloaded** (`apps/server/src/fork/threadHistory/`,
`apps/web/src/fork/threadHistory/`, `apps/mobile/src/fork/ThreadHistoryNotice.tsx`). Optional, off
without `~/.t3/userdata/fork-thread-history.json` (see Configuration). A thread that is settled
(`settledOverride = "settled"`) or archived, and not deleted, moves its history off the machine
once it has been settled or archived for an hour (so a thread just settled opens instantly; the
sweep rechecks at least every 10 minutes): every event except its `thread.*` events, its
`message.updated` events, its `run.*` events and its `provider-session.*` events, plus the
projection rows those events wrote (nodes, turn items, tool output, checkpoints...). Runs stay
because a thread's status in every list comes from its latest run; without them a finished thread
showed the working spinner. On one busy machine that moved 473 MB of the settled threads' 499 MB
of event JSON; the kept message text was about 18 MB, so lists, titles and content search
(`ThreadSearch`, which reads `orchestration_v2_projection_messages`, used by the sidebar search,
the phone and `t3_thread_search`) still find the thread by any phrase in it. A content search over
the store would have to download every blob per query. Attachments stay on disk.

- The one store today is `"azure-keyvault"`: an Azure Blob container, reached with a service
  principal whose credential is JSON in an Azure Key Vault secret, read with the machine's own
  `az` login when first needed and kept only in memory. `T3CODE_THREAD_HISTORY_SECRET` picks
  another secret, `off` turns the feature off. A Mac without an `az` login offloads nothing.
- Offload uploads a gzip bundle to `<environment id>/<SHA-256 of thread id>/<time>.json.gz` (thread
  ids can pass Azure's 1,024-character name limit), downloads it and
  checks its SHA-256, then deletes locally in one transaction that checks the thread again. It
  never moves a thread with a running or queued turn, a waiting request or secret request, pending
  effects or background work, a message waiting to start, a scheduled usage-limit resume, an open
  fork of it (forks read their source's rows), an event type it does not know, or a row id another
  thread owns (external bridges may reuse message ids). `fork_thread_history` keeps the pointer.
- Restore runs before every thread read and every command except metadata-only ones (visit, pin,
  rename, pull request sync, snooze, settle, archive, delete), from `ensureLegacyTranscript` in
  `ThreadManagementService`: opening, unsettling, unarchiving, sending, MCP `t3_thread_read` and the
  fleet's peer read all go through it. Events come back under new sequence numbers (so a client that
  cached the stub receives them) and their rows are rebuilt with the current projection code. A
  thread opened to read stays local until it is settled or archived again; each offload is a new
  blob, so re-settling restarts its retention.
  Restoring re-inserts events with new sequences, so a subagent prompt that upstream's event store
  keeps once (later events point at it with `promptSequence`) is re-pointed as it is put back.
- `fork.threadHistory` (stream RPC, read scope) reports `restoring`, `expired` or `unavailable`,
  shown in the composer's activity slot on web and desktop and above the composer on the phone.
  Expired (the blob is gone) leaves the stub readable; unavailable fails the read, so the client
  keeps retrying, and the notice has Retry.
- Retention is the storage account's lifecycle rule only (the clients say 60 days): create a rule
  that deletes blobs under the container's prefix that many days after creation. If the account's
  lifecycle policy holds other rules, change it by reading the policy, merging and writing it
  back, never by replacing it.
- Credentials: give the service principal only Storage Blob Data Contributor on the container.
  The Key Vault secret's value is JSON:
  `{"tenantId", "clientId", "clientSecret", "account", "container"}` (`blobStore.ts`).
- Disk: rows deleted inside SQLite free pages, not disk. `install-runtime.sh` switches the
  database to incremental vacuum once per machine, at a deploy (one `VACUUM` with the server
  stopped, 42 s for a 2.8 GB database), and the server runs `PRAGMA incremental_vacuum` after each
  offload.

**Restarts keep background work** (`apps/server/src/fork/restartWake.ts`, `apps/server/src/fork/drain.ts`,
`apps/server/src/fork/liveWork.ts`, `fork/scripts/live-work.sh`, `fork/scripts/deploy-when-idle.sh`). A thread whose turn has ended can still have work running:
Claude subagents, background shells and Monitors, which report back by waking the thread. A T3
restart kills them, and upstream only tells the agent on the user's next message (#15604 stopped
waking settled threads because stale "running" rows under stopped sessions woke long-finished
ones). Before this, two deploys and a restart once killed a thread's subagents and nothing
resumed them for an hour.

- Planned restarts drain the server first. Live work is what a restart would cut off: runs
  that are working or about to start, the provider's background roster (shells, Monitors),
  running subagent/shell/tool items, and a wake turn Claude started for a finished task.
  Background work counts only while its provider session is live. A held queued message (after
  Stop, a provider failure or a restart) does not count: it waits for a person and survives a
  restart. Sending a message to that thread, from the user or over MCP, resumes the held queue,
  earliest message first; upstream starts the user's new message ahead and leaves the hold to
  anything an agent sends. The server reads live work
  from its own projections (`liveWork.ts`, the same query as `live-work.sh`; `liveWork.test.ts`
  checks that they agree).
- The drain (`drain.ts`). Every 30 s run of a `deploy-when-idle.sh` job first POSTs
  `/fork/fleet/drain` on its own Mac with `{"action": "peek", "release", "requester"}` (the fleet
  secret as bearer), which changes nothing, and waits while the answer is not `idle`, taking new
  work as before. Once it is idle the run sends `"start"`: the server refuses new threads, messages
  and delegated tasks from clients and agents' tools (`ThreadManagementService.dispatch`),
  scheduled runs included, with "Not taking new work: this machine restarts for an update as soon
  as its running work finishes (waiting for <thread titles>). Send this to another machine, or
  again after the restart." and answers what is live again, also counting any command between the
  drain check and its commit. Idle: install. Not idle (work began between the two): the run sends
  `"cancel"` at once and waits again. So new work is refused only for the seconds between idle and
  the restart. The server's own continuations and wakes are never refused, since they finish the
  work it waits for; it refuses rather than queues because startup recovery holds every queued
  message until a person resumes it. A job scheduled from an agent's shell passes that agent's
  provider session (`CLAUDE_CODE_SESSION_ID`, `CODEX_THREAD_ID`) as `requester`, and both answers
  leave that thread's own work out (logged as `Not waiting for the thread that scheduled this
  deploy`), so an agent can wait for its own deploy; the restart cuts that work off and wakes the
  thread. The drain is held in memory: the restart ends it, and the job cancels it whenever it will
  not install (work began, superseded, installer failed). A server without the drain (a release
  before it, or no
  `fork-fleet.json`) is checked with `live-work.sh` instead. The daily `pull-deploy.sh` still
  waits for the next day while `live-work.sh` prints anything; when it prints nothing it
  schedules the `deploy-when-idle.sh` job, which drains before installing. There is no timeout:
  every check logs what it waits for and since when (`~/t3-fork/logs/deploy-when-idle-<sha>.log`).
  A dev server left running holds the deploy until it stops, which is the same rule. Restarts
  started by hand (`rollback.sh`, the in-app Update, `deploy-when-idle.sh --now`) and the
  watchdog's (a hung or runaway server cannot drain) do not wait.
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

**Start a thread snoozed** (`snoozedUntil` on `orchestration.launchThread` and `thread.create`,
`keepSnoozed` on `message.dispatch`). A caller running unattended work (an external bridge's
routine runs) creates its thread already snoozed, so it never shows in the inbox while its
worktree is prepared and its first message waits. Upstream refuses to snooze a thread with a
queued run and wakes a thread on every new message; a launch's initial message, or a later
message sent with `keepSnoozed`, leaves the snooze in place. A usage-limit continuation
(`fork/limitFailover.ts`) forks with `keepSnoozed` on `thread.fork`, so it keeps its source's wake
time; a fork asked by a person still starts visible. The wake rules are upstream's: the
run completing or failing after creation brings the thread back.

**Phone app** (`apps/mobile/src/fork/`, `fork/scripts/build-mobile.sh`,
`fork/scripts/artifacts-server.py`). An Android build, **Julia** (package `mobile_package`, the
Nightly icon), installs beside the Play Store app and pairs with your servers like the official
one. Where the phone has the matching screen it shows the fork: machine names (server side, so any
app shows them after pairing), machine pictures wherever it draws an environment's machine glyph,
Usage > Machines and the usage line in the new task Environment picker (above), and on Usage >
Limits the **Use now** and **Resets next** marks per provider (the web fork's
`buildAccountCards`, so phone and desktop always mark the same account) beside the plan tier the
servers already report (`Claude Max 20x`). Fleet awareness is agent-side, so the phone sees it
only in the agents' transcripts. Not on the phone, because it has no matching screen: the Auto
chip (the phone's new-thread flow has no machine balancing at all), the large environment-list
pictures (the phone's environment rows draw the glyph at 14 pt, and the picture keeps that
height). No push notifications (the fork build has no Firebase project) and no T3 Connect (no
Clerk keys); pairing is direct, for example over a tailnet.

The phone stays current without reinstalling. The app is Expo with `expo-updates`, and its runtime
version is the native fingerprint (`runtimeVersion.policy: fingerprint` in `app.config.ts`), so a
JavaScript-only change can be delivered over the air to every binary with the same native code,
and a native change cannot. The fork serves the Expo Updates protocol itself from the build Mac
instead of EAS (no Expo account, nothing leaves your network):

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

The app's package, scheme and update URL are passed to `app.config.ts` by `build-mobile.sh`
(`T3CODE_MOBILE_FORK=1`, `T3CODE_MOBILE_PACKAGE`, `T3CODE_MOBILE_SCHEME`,
`T3CODE_MOBILE_UPDATES_URL`, applied by `withForkConfig`); they are part of the native
fingerprint, so changing one needs a new APK. On a day whose upstream nightly changes native code
the fingerprint changes: the sync builds a new APK (Gradle took 7 minutes cold and 3m20s with its
cache on one build Mac; a JavaScript-only update is an export of about a minute), the installed app keeps its
last update, and the sync opens (or comments on) the issue **"Install the new phone app build"**
on your fork's repository with the link. Install it once on the phone; the APK is signed with the
same key, so it installs over the old one and keeps the pairings.

- Install link: `<artifacts_url>/mobile/<mobile_apk_name>.apk` (Android asks once to allow
  installs from the browser). Pair: on a Mac, `t3 pair` (or `t3 pair --tailscale`), then in the
  app Settings > Environments > + : the server's host, the code is the `token=` part of the
  printed link (or scan the QR with the camera button).
- Signing key: make it once on the build Mac with `keytool -genkeypair -storetype PKCS12
  -keystore <mobile_keystore>` (one key; `apksigner` signs with it) and write its password to
  `mobile_keystore_pass`, both mode 600 in a 700 directory, never in git. Losing it means every
  later APK needs an uninstall first (Android refuses a different key), which loses the app's
  pairings, so back it up.
- Toolchain on the build Mac: a JDK 21 (`JAVA_HOME`, default `~/t3-fork/toolchain/jdk21`) and the
  Android SDK in `~/Library/Android/sdk` (`ANDROID_HOME`; cmdline-tools, platform-tools, the
  platforms, build-tools, NDK and CMake versions React Native's `libs.versions.toml` pins).
- Manual: `fork/scripts/build-mobile.sh build <version> <out> ~/t3-fork/out/mobile` then
  `fork/scripts/build-mobile.sh publish <out> ~/t3-fork/out/mobile`.

**Packaging** (`apps/desktop/src/fork/`, `fork/scripts/`). The desktop app is **Julia**
(`desktop_bundle_id`) with its own Chromium profile
(`~/Library/Application Support/<desktop_package_name>`) and state (`~/<desktop_home_dirname>`),
no keychain use, and no update feed. The app is opened from Finder and never reads `fork.env`,
so `build.sh` writes those folder names into `apps/desktop/src/fork/identity.ts` for the build
(and restores the file afterwards), and passes the bundle id and package name to the packager.

## Configuration

All personal values live in files on your machines. The repository carries neutral defaults only.

### `~/.config/julia/fork.env` (the scripts)

`fork/scripts/fork.env` holds the defaults and sources `~/.config/julia/fork.env` when it exists
(a fixed path, so launchd jobs read it too), then derives `artifacts_url`. Same variable names,
shell syntax (`name=value`, quote values with spaces; `$HOME` may be used). Put the same file on
every Mac: every value is shared by the whole fleet, none is per machine.

| Variable               | Default                                 | Meaning                                                                                                                                                                                                                                                                                                                                                               |
| ---------------------- | --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fork_repo`            | (empty)                                 | The GitHub repository, `owner/name`, that gets the releases and the "Fork sync failed" and "Install the new phone app build" issues; the code goes to the clone's `origin` instead. It can be a separate private repository, which is wise: releases embed your hosts and issues carry logs. Empty: `sync.sh` (except `--dry-run`) and the deploy jobs refuse to run. |
| `fork_branch`          | `main`                                  | The branch the daily sync rebases onto upstream and pushes.                                                                                                                                                                                                                                                                                                           |
| `version_label`        | `fork`                                  | The word in fork versions (`<nightly>.<word>.<epoch>+<word>.<sha>`) and release tags (`<word>-<nightly>-<sha>`); `install-runtime.sh` prunes old runtimes by it.                                                                                                                                                                                                      |
| `job_label_prefix`     | `dev.julia.fork`                        | Prefix of the LaunchAgent labels: `.sync`, `.deploy`, `.watchdog`, `.artifacts`, `.aside-helper`, `.deploy-when-idle-<sha>`.                                                                                                                                                                                                                                          |
| `aside_login_label`    | (empty)                                 | The LaunchAgent that opens Aside at login, which `install-aside-helper.sh` disables while Aside runs under the helper (and restores on `--uninstall`). Empty: none.                                                                                                                                                                                                   |
| `desktop_bundle_id`    | `dev.julia.app`                         | The desktop app's bundle id. `install-desktop.sh` refuses to replace an app with another id, and fixes the Dock tile with it.                                                                                                                                                                                                                                         |
| `desktop_package_name` | `julia`                                 | The desktop app's package name: its keychain item name and its Chromium profile folder under `~/Library/Application Support`. Embedded at build.                                                                                                                                                                                                                      |
| `desktop_home_dirname` | `.julia-app`                            | The folder in `$HOME` for the desktop app's own state (its pairings). Embedded at build; `install-desktop.sh` seeds its settings there.                                                                                                                                                                                                                               |
| `desktop_legacy_app`   | (empty)                                 | An older name of the desktop app in `/Applications` (without `.app`) that `install-desktop.sh` replaces with `Julia.app` and the deploy jobs still recognize. Empty: none.                                                                                                                                                                                            |
| `mobile_package`       | `dev.julia.app`                         | The Android app's package id. Part of the native fingerprint.                                                                                                                                                                                                                                                                                                         |
| `mobile_scheme`        | `julia`                                 | The Android app's URL scheme. Part of the native fingerprint.                                                                                                                                                                                                                                                                                                         |
| `mobile_apk_name`      | `Julia`                                 | File name (without `.apk`) of the published APKs and of the install link `<artifacts_url>/mobile/<name>.apk`.                                                                                                                                                                                                                                                         |
| `mobile_keystore`      | `$HOME/t3-fork/keys/julia-release.jks`  | The APK release signing key (PKCS12).                                                                                                                                                                                                                                                                                                                                 |
| `mobile_keystore_pass` | `$HOME/t3-fork/keys/julia-release.pass` | The file holding that key's password.                                                                                                                                                                                                                                                                                                                                 |
| `build_mac_url`        | (empty)                                 | The build Mac's T3 Code server as the other machines reach it (for example its Tailscale Serve URL); auto-fix chat links point there.                                                                                                                                                                                                                                 |
| `artifacts_url`        | `<build_mac_url>:8444`                  | Where the build Mac serves its build outputs and the phone's updates (`install-jobs.sh artifacts`). Every Mac downloads releases from it. `T3CODE_ARTIFACTS_URL` overrides it for `build-mobile.sh`.                                                                                                                                                                  |

`build.sh` also exports `T3CODE_FORK_RELEASE_BASE_URL` from `artifacts_url` for the build, and
`apps/server/vite.config.ts` embeds it in the server (`packages/shared/src/cliRelease.ts`): a
server built with it downloads fork runtimes (versions with `+<version_label>.<sha>`) for **Update
all** from `<artifacts_url>/<version>`. Built without it (for example a plain `vp run build`), fork
versions are looked up on upstream's GitHub releases, where they do not exist.

The desktop and phone identities are compiled into the apps, so changing one later means a new
app: a new bundle id or package name is a different app with no pairings, and a new
`desktop_home_dirname` starts with empty state.

### `~/.config/julia/denylist` (the literal check)

Optional. One fixed string per line (your host names, tailnet name, account logins, emails, label
prefixes). `fork/scripts/check-literals.sh`, run first by `checks.sh`, fails when any line the
fork adds or changes against its upstream base contains one (case-insensitive), besides its
built-in patterns for tailnet hosts, Mac host names and Tailscale IPs. Keep it on the build Mac at
least, since the sync runs the check there. The repository's pre-push hook
(`.vite-hooks/pre-push`) runs the same check on each pushed commit, so a committed personal value
blocks any push from a clone whose hooks are installed (the `prepare` script, `vp config`, sets
`core.hooksPath`), while uncommitted and untracked files do not. With `--commit`, as in that hook, it also
checks the author, committer and message of every commit since the base; an author or committer
on GitHub's `<id>+<login>@users.noreply.github.com` address is skipped, since GitHub shows that
login and name on the commit anyway.

### Per-machine server files (`~/.t3/userdata/`)

- `environment-label`: one line, the machine's short name for every client (Machine names).
- `fork-fleet.json` (mode 600): fleet awareness, moves and remote subagents.
  `{"hubUrl", "selfUrl", "secret", "hub": true only on the hub, "pathMeanings": [...]}`.
  `hubUrl` and `secret` are the same on every machine; `selfUrl` is the machine's own URL as the
  others reach it. Generate the secret once (`openssl rand -hex 32`). `pathMeanings` (optional,
  same on every machine): `[{"repo": "<regex on the repository key, case-insensitive>", "path":
  "<regex whose first group is the label>", "kind": "sku" | "provider"}]`; the first matching
  rule names the path, and a malformed rule is skipped. Without the file the fleet is off and the
  drain falls back to `live-work.sh`.
- `fork-thread-history.json` (mode 600): offloading settled threads.
  `{"store": "azure-keyvault", "keyVault": "<vault name>", "secret": "<secret name>"}`, the same on
  every machine. Put it on every machine before the first deploy that uses it if any thread was
  ever offloaded there: restoring needs it too. Without it nothing is offloaded or restored.

## Upstream files touched

Everything else lives in `fork/`, `FORK.md`, and the `fork/` directories under `apps/`. Each
upstream edit is a hook (an import plus a call), marked `Fork:` where it is not obvious.

```
git diff --stat <upstream-tag>...<fork_branch> -- . ':(exclude)FORK.md' ':(exclude)fork/**' ':(glob,exclude)apps/*/src/fork/**'
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
- `apps/server/vite.config.ts`: embeds `T3CODE_FORK_RELEASE_BASE_URL` (the fork's release host for
  `packages/shared/src/cliRelease.ts`) at build time.
- `scripts/build-desktop-artifact.ts`: app id, product name and package name from the environment
  (`build.sh` passes them from `fork.env`).
- `apps/server/src/mcp/McpHttpServer.ts`: adds the fleet layer (toolkit, publisher) to the MCP server, and the fleet routes beside `/mcp`, outside its auth middleware.
- `packages/contracts/src/orchestratorMcp.ts`: optional `machine` on `delegate_task`, `machine` and
  `link` on its result.
- `apps/server/src/mcp/toolkits/orchestrator/handlers.ts`, `tools.ts`: `delegate_task`,
  `task_status` and `task_cancel` hand remote tasks to `fork/fleet/remoteTasks.ts`; the tool
  descriptions mention `machine`; `orchestrator_capabilities` takes a `machine` too.
- `apps/server/src/mcp/OrchestratorMcpService.ts`: exports `taskStatusForRun`.
- `packages/contracts/src/orchestrationV2.ts`, `apps/server/src/orchestration-v2/ThreadLaunchService.ts`,
  `Orchestrator.ts`: optional `remoteParentThreadId` on `thread.create` and the launch input makes
  the new thread a subagent of a thread on another machine; `recordSubagentFollowup` in
  `Orchestrator.ts` skips children not forked from a parent task node, so a follow-up to such a
  thread is not refused for its missing parent; tests in `ThreadLaunchService.test.ts`.
  `packages/client-runtime/src/state/threadShell.ts`: `subagentThreadShellsAtom` also nests
  subagents from other environments that name a parent their own environment lacks; test in
  `threadShell.test.ts`.
- `packages/provider-core/src/server/orchestrationInstructions.ts`: the advice for work on another
  machine (a remote subagent through `delegate_task` with `machine`, and how to choose it).
- `apps/mobile/app.config.ts`: `withForkConfig(config)` (identity and update URL, only with `T3CODE_MOBILE_FORK=1`).
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
- `apps/web/src/components/ChatView.tsx` (again): the unavailable-machine banner says whether this
  device's network or that server is at fault (`fork/outageCause/`): every machine unreachable
  means the network, another machine connected means the server.
- `apps/web/src/components/chat/ModelPickerContent.tsx`, `ModelPickerSidebar.tsx`: dims limited
  instances in the rail.
- `apps/server/src/provider/CodexProvider.ts`: the Codex default model and effort from
  `fork/codexDefaults.ts`.
- `apps/server/src/auth/SessionStore.ts`: session scopes go through `fork/pairedOperatorScopes.ts`.
- `apps/server/src/auth/SessionStore.ts` (again): a session's deadline is its stored row, which
  `fork/sessionRenewal.ts` moves on connect, on disconnect and when a live socket reaches it.
- `apps/server/src/persistence/AuthSessions.ts`: `setExpiresAt`, the write that renewal uses.
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
- `packages/contracts/src/orchestrationV2.ts`, `apps/server/src/orchestration-v2/ThreadLaunchService.ts`,
  `Orchestrator.ts`: start a thread snoozed (`snoozedUntil`, `keepSnoozed`); test in
  `ThreadLaunchService.test.ts`; `ws.ts` maps the client's launch request through
  `ThreadLaunchService.launchInputFromWire`. `ThreadForkService.ts`, `fork/limitFailover.ts`: a
  continuation keeps the snooze; tests in `ThreadFork.execution.test.ts`, `ThreadForkService.test.ts`,
  `limitFailover.test.ts`.
- `apps/server/src/orchestration-v2/ThreadManagementService.ts` (again), `fork/pendingSettle.ts`,
  `runtimeLayer.ts`: an agent's settle of its own thread mid-turn is kept on the thread
  (`settleAfterRunId` on the thread and `thread.metadata.update`), and startup waits again for
  each one a restart cut off; test in `runtimeLayer.test.ts`.
- `apps/server/src/orchestration-v2/Orchestrator.ts` (again): `run.interrupt` on a run still waiting
  in the queue cancels it (as `queued-run.cancel`) instead of refusing; test in
  `ThreadLaunchService.test.ts`.
- `apps/server/src/orchestration-v2/ProviderSessionManager.ts`: a settled Codex thread with
  background work stays loaded instead of having its terminals stopped; test in
  `ProviderSessionManager.test.ts`.
- `apps/server/src/orchestration-v2/ThreadManagementService.ts` (again): `dispatch` goes through
  `fork/drain.ts`'s `admit`; `apps/server/src/ws.ts`: a launch the drain refused says why.
- `apps/server/src/orchestration-v2/ProviderRuntimeRecoveryService.ts`: shutdown intent and crash
  recovery also queue a restart continuation for `fork/restartWake.ts`'s settled run;
  `RestartContinuation.ts` and `Orchestrator.ts` admit that continuation with the note as its prompt.
  Their tests (`RestartContinuation.test.ts`, `runtimeLayer.test.ts`,
  `testkit/OrchestratorReplayRestartBackgroundNote.integration.test.ts`) expect the wake;
  `testkit/ProviderReplayHarness.ts` gains `shutdownLikeServer` to close as the server does.
- `apps/server/src/terminal/Manager.ts`, `project/ProjectSetupScriptRunner.ts`: `open` takes
  `workspaceLeaseHeld`, which `workspace/WorktreeRestore.ts` sets so the setup terminal of a
  restored worktree opens under the run start's lease instead of waiting on it forever. Every
  terminal open, launching attach and restart takes the lease before the thread lock, so a user
  terminal on the same thread cannot deadlock that setup open; attaching to an existing session
  takes no lease. Tests in `WorktreeRestore.test.ts` and `terminal/Manager.test.ts`.
- `apps/server/src/orchestration-v2/ShellStream.ts`: a native subagent's runless `root_turn`
  `node.updated` still reaches the shell stream (upstream #23783 drops subagent node updates), so a
  finished Task subagent leaves the sidebar without a refresh; test in `ShellStream.test.ts`.
- `apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts`: in a full-access thread, Claude
  Code's dangerous-removal safety check (`Dangerous rm operation ...`, which bypass cannot allow)
  is denied after Claude Code's own 120 s window when nobody answers, with a message telling the
  agent how to rewrite it, and the card shows expired (`fork/claudeSafetyCheckAutoDeny.ts`). The
  SDK passes no window or check kind to `canUseTool`, so the reason text identifies the check.
  Tests in `ClaudeAdapterV2.test.ts`.
- `scripts/build-cli-archive.ts`: a Linux archive built on a Mac skips the steps that need a Linux
  host (bundling `libatomic.so.1` with `ldd`, `dpkg-query` and `patchelf`, and GNU tar's
  `--hard-dereference`), so a Linux machine running it needs the `libatomic1` package (Linux
  machines, below).

Commit series on the fork branch (oldest first), one series per feature so each can be dropped or
proposed on its own: free disk + Auto (2 commits), pictures (1), Claude tier + Usage by account
(2; Usage reuses Auto's `chooseAutoAccount`), move to another machine (1; reuses Auto's rules),
machine names (1), fleet awareness (1), packaging (1), tooling (2), this file (1), then move over
the fleet instead of GitHub (1; the move feature now depends on fleet awareness), overlap alerts
(1), opening the moved thread once the client knows it (1), then the phone app: its identity (1),
pictures and account marks (1), sync and update serving (1), and its layout fix with this section (1),
then Machines (1; adds total disk to the free disk commit's field and owner), then usage in the
machine pickers (1), account limits in the model pickers (1), then Auto's account on the phone and
in scheduled runs (1; moves the account rule to `packages/shared`), then limited accounts on
desktop and the Codex default (1), then providers on every machine (1), then settled threads
offloaded (1).

## Sync, build, deploy

One Mac is the build Mac: it holds a clone of your fork at `~/src/t3code-fork` (with `origin` =
your fork, `upstream` = pingdotgg/t3code), rebases and builds daily, and serves the build
outputs. The scripts push code to that clone's `origin` remote; releases and issues go to
`fork_repo`, which can be a different, private repository. When it is, `sync.sh` also
force-pushes the rebased branch there, since a release can only point at a commit its repository
has. Every Mac, the build Mac included, pulls and installs the newest release.

```
build Mac 05:00  <prefix>.sync    fork/scripts/sync.sh
             fetch upstream tags -> rebase fork_branch onto the newest v*-nightly.* tag
             -> fork/scripts/checks.sh (check-literals.sh: no personal host or ID in the fork's
                changes; typecheck of contracts/web/server/desktop/scripts/mobile,
                lint of every file the fork touches, fork tests + tests beside touched files)
             -> fork/scripts/build.sh (server runtime archives darwin-arm64 and linux-x64
                + Julia.app)
             -> fork/scripts/build-mobile.sh build (phone update; an APK only on a new fingerprint)
             any of these fails -> fork/scripts/autofix.sh: an agent chat on the build Mac fixes
                it, then the same checks and builds run again (see "When the sync fails")
             -> push fork_branch, GitHub release <version_label>-<version>-<sha> on fork_repo
                (VERSION, SHA256SUMS, install scripts)
             -> ~/t3-fork/out/latest-release (<tag> <version>), for the Linux machines
             -> build-mobile.sh publish (into ~/t3-fork/out/mobile); a new APK opens the issue
                "Install the new phone app build"
build Mac always <prefix>.artifacts  ~/t3-fork/artifacts-server.py: ~/t3-fork/out served at
             artifacts_url (Tailscale Serve :8444 -> 127.0.0.1:8790), plus /mobile/manifest
phone  every launch  Julia asks /mobile/manifest for its runtime; downloads a newer update in
             the background and applies it at the next backgrounding
every Mac 05:45 <prefix>.deploy ~/t3-fork/pull-deploy.sh
             newest release not yet running -> download its artifacts from artifacts_url, check
             SHA256SUMS -> deploy-when-idle.sh --schedule (and install-desktop.sh where the app
             is installed); waits for the next day while live-work.sh reports anything
any Mac, on demand  <prefix>.deploy-when-idle-<sha>  ~/t3-fork/deploy-when-idle.sh
             fork/scripts/deploy-when-idle.sh --schedule <release tag> waits until nothing is
             live (checked every 30 s, logged), drains the server for the restart and installs
             that release, then removes itself; a newer release supersedes it
every Mac every 60 s <prefix>.watchdog ~/t3-fork/watchdog.sh
             restarts the T3 service after 3 failed localhost health checks or above 12 GB
             RSS, first saving a 5 s `sample` to ~/t3-fork/logs/watchdog-sample-*.txt
```

`<prefix>` is `job_label_prefix`. To ship a release to a Mac without waiting for 05:45, schedule
it with `fork/scripts/deploy-when-idle.sh --schedule <release tag>`. Add `--now` to install
without waiting, cutting off whatever runs. `--cancel <release tag>` removes a waiting job and
ends its drain. `install-runtime.sh` also refreshes `~/t3-fork/pull-deploy.sh` and `fork.env`, and
installs or refreshes the watchdog from the release it installs.

The scripts read every name, host and ID from `fork/scripts/fork.env` (and through it your
`~/.config/julia/fork.env`), which ships in each release and is installed beside every script
copied to `~/t3-fork`.

**Setting up.** On every Mac: install T3 Code's service (`t3 service install`), `gh auth login`
with access to your fork, write `~/.config/julia/fork.env`, then from a fork checkout
`fork/scripts/install-jobs.sh deploy`. On the build Mac, in `~/src/t3code-fork`:
`fork/scripts/install-jobs.sh sync artifacts deploy`. Toolchain on the build Mac: `vp`
(`curl -fsSL https://vite.plus | VP_NODE_MANAGER=no bash`), Rust stable via rustup, Node 24,
Xcode command line tools, `gh`, Tailscale (for `tailscale serve`), and the Android toolchain
above; for the Linux archive, `rustup target add x86_64-unknown-linux-musl` once. Where
`~/t3-fork` is a symlink onto a removable volume, an `ExternalLauncher.app` in
`~/Applications` holding the macOS access grant runs the jobs (`install-jobs.sh`,
`deploy-when-idle.sh`); jobs it has no service for are refused. Where `~/t3-fork` is a real
directory, the jobs run their scripts directly even with the launcher installed.

**Why a build Mac and not a GitHub Action:** the desktop app must be built on macOS. GitHub's
macOS runners bill private-repo minutes at ten times the Linux rate, and an Action cannot reach
the Macs without putting a tailnet auth key in GitHub. A Mac that is always on builds in a few
minutes, and every Mac reaches GitHub with its own `gh` login, so a pull from each Mac replaces a
push from the build Mac (no Mac needs Remote Login). The large artifacts travel over your network
from the build Mac, not through GitHub: uploading 80-150 MB artifacts to GitHub failed about one
time in three in testing (broken pipe and TLS errors).

**When the sync fails** (a rebase conflict, or a failed check, desktop build or phone build),
`fork/scripts/autofix.sh` hands it to an agent chat in T3 Code on the build Mac (full access; the
first model in Settings > General > "Fork sync auto-fix models" whose provider has an account with
usage left, on the account Auto would pick; default Claude Opus, then GPT-6.1; see
`apps/server/src/fork/autofixAccount.ts`), titled "Fork sync auto-fix: <upstream ref>", so it
appears in the app under the fork's project on the build Mac. The chat works in the git worktree
`~/t3-fork/autofix/<stamp>/worktree` (branch `autofix/<stamp>`, started at `origin/<fork_branch>`):
it rebases, resolves conflicts inside the fork commit being replayed, reruns `checks.sh`,
`build.sh` and `build-mobile.sh build`, and writes `~/t3-fork/autofix/<stamp>/report.md`
(`RESOLVED` or `UNRESOLVED`, what conflicted and how it was resolved). The sync waits for the
chat to finish, at most one hour: after that it stops the chat's turn, as the Stop button does,
and treats it as unresolved. It then accepts its branch only if the report says `RESOLVED`, no
rebase is left in progress, the branch sits on the upstream ref, the fork's commit subjects are
unchanged in order and number (no "fix conflicts" commit), nothing under `fork/` changed, the
fork's own test cases did not drop, upstream tests went only from test files the fork already
strips (a fork commit deletes that feature, as with automatic thread settling; the release notes
list them), and its `.skip`/`.only`/`@ts-ignore`/`@ts-expect-error`/lint-disable count did not
grow (`fork/scripts/autofix-guards.sh`). It then runs the very same rebase check, checks and builds itself on that
branch; only if they pass does the normal push and release happen, and the release notes carry
the chat link and the agent's report for audit. The chat's worktree is removed then. Each
auto-fix chat is settled once a newer one starts or a sync publishes, so the active list shows at
most the latest failed sync's chat; the rest stay under Settled. Chats someone pinned or reopened
are left alone.

**Where a failure shows up:** if the agent cannot get everything green, times out ("timed
out after 1 hour"), or its branch fails the guards or the rerun, nothing is released, so nothing
deploys, and the job opens (or comments on) the issue **"Fork sync failed"** on `fork_repo` with
the step, conflicting files, the chat link, the agent's report and verdict, and the log tail. The
agent's worktree is kept in `~/t3-fork/autofix/<stamp>/worktree` to continue from. GitHub
notifies the repository's owner; the daily deploy job on a Mac with the desktop app also raises
a macOS notification while that issue is open. The next successful sync closes it. Logs:
`~/t3-fork/logs/` on each Mac.

Only the first run in 23 hours (normally the 05:00 job) looks at upstream and may start an
auto-fix chat; it records that in `~/t3-fork/upstream-checked`. Any later run builds and
publishes the fork on its current base, and on a failure it only opens the issue. Upstream
cuts several nightlies a day, and without this every manual ship would start its own hour-long
chat. Dry runs ignore the gate.

Manual runs, on the build Mac:

```
~/src/t3code-fork/fork/scripts/sync.sh                          # publish now (rebase only if upstream unchecked for 23 h)
~/src/t3code-fork/fork/scripts/sync.sh --dry-run                # rebase+check+build (+auto-fix) only
~/src/t3code-fork/fork/scripts/sync.sh --dry-run upstream/main
~/t3-fork/pull-deploy.sh                                        # on any Mac: install now
```

Resolving a conflict by hand (after the auto-fix gave up): `cd ~/src/t3code-fork && git rebase
<tag>` on the build Mac, fix the hook in the listed upstream file, `git rebase --continue`, then
run `fork/scripts/sync.sh`. `sync.sh --dry-run <ref> <seconds>` shortens the one-hour limit for a
test; only a dry run accepts it, and the 05:00 job passes no arguments. A dry run with a failure
also starts a real auto-fix chat (it publishes nothing and prints the issue body or release notes
it would have used). `sync.sh` works on the clone it lives in, so a test can run from a scratch
clone whose `origin`/`upstream` are local.

### How a deploy works on one Mac

The LaunchAgent `com.t3tools.t3code.service` stays exactly as `t3 service install` wrote it:
it runs the **stock** runtime's `t3 __service-launcher`, which starts
`~/.t3/runtime/versions/<activeVersion>/t3 serve`. `install-runtime.sh` unpacks the fork
runtime beside the stock one, sets `activeVersion` in `~/.t3/runtime/service-state.json`,
restarts the agent, and waits for `/.well-known/t3/environment` to report the new version
(rolling back to the previous version if it does not within the launcher's own 120 s). Same
data dir, label, port 3773 and Tailscale Serve. Because the launcher binary does not change,
its Full Disk Access grant keeps applying. It keeps the stock runtime and the previous fork
runtime on disk.

Fork versions are `<upstream nightly>.<version_label>.<build epoch seconds>+<version_label>.<sha>`.
The numeric prerelease revision orders fork builds of one nightly; the hash is only artifact
identity. The existing stock launcher understands this ordering without changing its binary or
privacy grants. A newer upstream nightly still sorts after every fork build of the previous
nightly. The fork remains outside upstream's nightly-channel pattern, so it reports the stable
channel.

Fork runtime downloads use the build Mac's artifact server (`T3CODE_FORK_RELEASE_BASE_URL`,
embedded at build; see Configuration) and exact-version directories, including checksum
verification; `T3CODE_RELEASE_BASE_URL` still overrides the source for an explicit mirror. The built-in **Update all** can then synchronize older servers with the
client's fork version.

### Linux machines

Linux x86_64 machines (systemd, for example Ubuntu Server) run the same server from the
release's `t3-<version>-linux-x64.tar.gz`, cross-built on the build Mac by `build.sh`: Node's
single executable for linux-x64, the runtime packages' linux-x64 builds, and a static (musl)
resource monitor. If only that cross-build fails, the release ships without it: the Macs deploy
it, `latest-release` keeps naming the last release with a Linux archive, and the "Fork sync
failed" issue says so. Every machine downloads only the files it installs (`fork_release_files` in
`fork.env`): a Linux machine its archive, a Mac everything else.

The service is upstream's systemd user unit `t3code.service`, which `t3 service install` writes
and which needs lingering (`sudo loginctl enable-linger <user>`). It starts the launcher of the
runtime it was installed from, and there is no stock runtime to keep, so `install-runtime.sh`
switches versions with the new runtime's own `t3 service install` (also on the first install,
where no service exists yet) and rolls back the same way. The deploy job is a systemd user timer
and service named like the LaunchAgent (`<prefix>.deploy`, 05:45, `Persistent=true`), and
`deploy-when-idle.sh --schedule` writes a timer that runs every 30 s and retires itself after the
install. Not on Linux: the watchdog (the unit's `Restart=always` covers a crash, not a hang),
the desktop app, the build jobs. Packages the scripts need: `libatomic1`, `curl`, `python3` and
`sqlite3` (for `live-work.sh`).

A Linux machine holds no GitHub login. It learns the newest release from `artifacts_url/latest-release`
(`<tag> <version>`, which `sync.sh` writes with `latest-release.sh` once the release is
published, and again when a rerun finds it already published) and downloads
`VERSION`, `SHA256SUMS` and `fork-scripts.tar.gz` from `artifacts_url/<version>/` beside the
archive (`fork_latest_release` and `fork_download_release` in `fork.env`; a Mac still uses the
GitHub release). Its checksums so come from the same server as the archive: they catch transfer
errors, and the build Mac is trusted for both, as it already is for the archives.

Setting up one: put the four local files (Configuration) in place, download the newest release
(the tag and version in `artifacts_url/latest-release`, then `VERSION`, `SHA256SUMS`,
`fork-scripts.tar.gz` and the archive from `artifacts_url/<version>/`), check the archive with
`sha256sum -c`, run its `install-runtime.sh <archive>`, then `install-jobs.sh deploy`, and publish
port 3773 with `tailscale serve --bg --https=443 http://127.0.0.1:3773`.

### Rollback (one line per machine)

```
~/t3-fork/rollback.sh <stock runtime version, e.g. 0.0.46-nightly.20261005.2702>
```

Run it on each Mac. It switches the service back to the stock runtime and stops the daily
deploy job and any pending `deploy-when-idle` job. On a Linux machine, give it the previous fork version under `~/.t3/runtime/versions`. Desktop: quit Julia and open T3 Code (Nightly), which keeps its own pairings. To
resume the fork: `fork/scripts/install-jobs.sh deploy` then `~/t3-fork/pull-deploy.sh`.

### Building by hand

```
fork/scripts/build.sh <version> <out-dir>
fork/scripts/install-runtime.sh <out-dir>/t3-<version>-darwin-arm64.tar.gz   # linux-x64 on Linux
fork/scripts/install-desktop.sh <out-dir>/T3-Code-*-arm64.zip
fork/scripts/install-jobs.sh deploy        # every Mac;  on the build Mac: sync artifacts deploy
```

## Keychain

Nothing the fork deploys asks for the keychain.

- **Desktop app.** Electron safe storage (which encrypts the saved pairings) keeps its key in a
  keychain item whose access list names the app by code hash: an app signed without an Apple
  Team ID cannot be named any other way, so every rebuild would prompt for the login password
  again (seen in securityd's log as "ACL partition mismatch: client cdhash"). The fork app
  starts Chromium with `--use-mock-keychain` (`apps/desktop/src/fork/keychain.ts`), so safe
  storage uses a fixed key and never reads the keychain. The trade-off: the fork app's saved
  pairings in `~/<desktop_home_dirname>` are protected by file permissions only, the same as the
  server's own secrets in `~/.t3/userdata/secrets`.
- **Servers.** The T3 server reads one keychain item, the Cursor CLI login for Cursor usage, and
  only when "Cursor account usage" is turned on. Claude and Codex read their own credentials in
  their own processes, whose binaries the fork does not change.

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
  machine) rather than a fork-only shared secret, and the path meanings left to configuration.
- **Packaging**: `T3CODE_DESKTOP_APP_ID`/`_PRODUCT_NAME`/`_PACKAGE_NAME` overrides are useful to
  any fork; the profile split would need a build-time flag instead of the bundle-name check and
  the generated `identity.ts`.

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
  copy in full (about 250 GB for 70 GB actually used on one machine).
  `fork/scripts/disk-usage.py <dirs> --context <other dirs> --skip-git` reports what a folder really
  uses and what deleting it would free. Never run `pnpm store prune` here: with clones every store
  file has one link, so prune deletes the whole store and the next install downloads it again.

## Deviations

- Limit failover names its tab on the source before sending the tab's first message. A crash between the two would leave a named tab that never starts, so the usage-limit
  sweep keeps such a source as a candidate until the tab's `<tab id>:continue` message exists,
  bounded like every failover by the limit's reset. That branch ignores the source's settled or
  archived state, because an external bridge may settle a source once it names its tab.
- Auto reuses upstream's load-balancing setting and per-machine preference instead of a new
  setting: "Manual only" excludes a machine; any other preference makes it eligible, and the
  Prefer/Normal/Less often levels have no further effect under the fork rule.
- "Laptops excluded unless enabled" is implemented as "laptops default to Manual only", since the
  environment's machine kind (`laptop`) is what T3 knows about a laptop.
- Available memory is T3's own `server.getHostResources` figure (free + inactive + speculative
  pages on macOS), not Activity Monitor's "memory used" figure the Happier fork used.
- The desktop app's window title and menu read "T3 Code (Alpha)": T3 derives that label from the
  version, and the fork version's `+<version_label>` suffix is outside upstream's nightly pattern.
  The app bundle, Dock and Finder name are "Julia".
- The fork app is paired fresh with each server (rather than granted the official app's keychain
  item), so it has its own pairing records on each server.
- Desktop updates install into /Applications without quitting a running app; the new build runs
  at the next launch.
- The phone app is Android only; the iOS config is untouched. Its build is part
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
  a new keybinding command in contracts and shared defaults for a tab opened by clicking.
- A machine's "last seen" is what this client saw since it started; a machine already offline when
  the app opens shows `not seen since the app opened`. No server keeps a history to ask.
- The moved-thread banner is remembered by the client that did the move; other clients see the
  source thread's "Moved to ..." title.
- Fleet lifecycle changes are noticed through the domain event stream only as a trigger to
  rebuild from projections; T3 has no lifecycle-only subscription, so the fork filters the event
  types itself. A Claude read-only (Supervised) thread does not pre-approve the fleet tools; T3's
  read-only allowlist is upstream code the fork leaves alone.
- Usage in the machine pickers ("show the usage details when deciding what machine to put the
  code on") was read as: wherever a machine is picked for a thread, each
  machine shows its live CPU, memory and disk from the Machines tab's own data and formatting.
  The Auto option keeps its "why" text and gets no line of its own. The thread title menu is
  native (Electron), so its Move items show the reading taken as it opens instead of a live one;
  opening it waits for that reading (a fresh sample takes the server about 200 ms of CPU
  measuring, at most the existing 5-second query timeout for a server that does not answer).
