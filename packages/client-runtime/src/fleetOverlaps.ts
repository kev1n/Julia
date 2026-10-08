/** Fork (Owner): intent-based suggestions shared by web/desktop and mobile. */
import type { ForkFleetOverlap } from "@t3tools/contracts";

/** Dismissal follows the relationship, not paraphrased reasons or heartbeat timestamps. */
export function fleetOverlapSignature(overlaps: ReadonlyArray<ForkFleetOverlap>): string {
  return JSON.stringify(
    overlaps
      .map((overlap) => [overlap.environmentId, overlap.threadId, overlap.kind])
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
  );
}

export function fleetOverlapTitle(overlaps: ReadonlyArray<ForkFleetOverlap>): string {
  const [first] = overlaps;
  if (!first) return "";
  if (overlaps.length > 1) return `${overlaps.length} chats may benefit from coordinating`;
  const relationship =
    first.kind === "conflicting_intent"
      ? "may be working against this chat"
      : "may be investigating the same bug";
  return `"${first.title}" on ${first.machine} ${relationship}`;
}

export function fleetOverlapReasons(overlaps: ReadonlyArray<ForkFleetOverlap>): string {
  return overlaps
    .slice(0, 3)
    .map((overlap) =>
      overlaps.length === 1 ? overlap.reason : `"${overlap.title}": ${overlap.reason}`,
    )
    .join(" ");
}

/** Only fills the draft; sending is the user's decision. */
export function fleetOverlapPrompt(overlaps: ReadonlyArray<ForkFleetOverlap>): string {
  return [
    "These chats may benefit from coordinating with this work:",
    ...overlaps.map(
      (overlap) =>
        `- "${overlap.title}" on ${overlap.machine} (${overlap.lifecycle}; environmentId ${overlap.environmentId}, threadId ${overlap.threadId}): ${overlap.reason}`,
    ),
    "Read them with t3_fleet_thread_read and compare their goals and findings with ours. Explain whether coordination would help. Do not message another chat unless I ask you to.",
  ].join("\n");
}
