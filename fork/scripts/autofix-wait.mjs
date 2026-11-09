// When an auto-fix chat is done, judged from its thread on the shell stream
// (autofix-thread.mjs feeds it every update of the chat's thread).

// A run is over once it reaches one of these and no background work remains.
export const ended = new Set([
  "idle",
  "completed",
  "interrupted",
  "failed",
  "cancelled",
  "rolled_back",
]);

// Returns check(thread): the chat's final status once the agent is done, else null.
export function chatWaiter() {
  let started = false;
  // Background work that outlives the agent's run wakes the agent with its result in a
  // new run, but the server drops the work from the thread before it starts that run,
  // so for a moment the thread looks finished. Wait for that run instead; a newer
  // latest run means it came, even if it ran while the stream was reconnecting.
  let wakePending = false;
  let latchedRunId = null;
  return (thread) => {
    const working = (thread.pendingBackgroundTasks ?? []).length > 0;
    if (thread.activeRunId || !ended.has(thread.status)) {
      started = true;
      wakePending = false;
    } else if (working) {
      wakePending = true;
      latchedRunId = thread.latestRunId;
    } else if (wakePending && thread.latestRunId !== latchedRunId) {
      wakePending = false;
    }
    if (thread.pendingRuntimeRequest)
      return `waiting for input (${thread.pendingRuntimeRequest.kind})`;
    const idle = !thread.activeRunId && ended.has(thread.status) && !working && !wakePending;
    return idle && (started || thread.latestRunCompletedAt) ? thread.status : null;
  };
}
