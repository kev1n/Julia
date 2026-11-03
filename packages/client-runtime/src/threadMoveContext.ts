/**
 * Fork: a moved thread's first message. The new server has none of its history, so the
 * client selects like T3's portable handoff: the original request, then the latest whole messages
 * that fit T3's handoff default (16,000 tokens, one per UTF-8 byte).
 */
export const MOVE_CONTEXT_BUDGET_BYTES = 16_000;

export interface MoveContextMessage {
  readonly role: "user" | "assistant" | "system";
  readonly text: string;
}

const encoder = new TextEncoder();
const byteLength = (text: string) => encoder.encode(text).length;

function render(message: MoveContextMessage): string {
  return `[${message.role}]\n${message.text.trim()}`;
}

/** Indexes of the messages to carry, oldest first. */
export function selectMoveHistory(
  messages: ReadonlyArray<MoveContextMessage>,
  budgetBytes: number,
): { readonly indexes: ReadonlyArray<number>; readonly omitted: number } {
  const usable = messages
    .map((message, index) => ({ message, index }))
    .filter(({ message }) => message.role !== "system" && message.text.trim() !== "");
  const first = usable.find(({ message }) => message.role === "user");
  const chosen = new Set<number>();
  let used = 0;
  if (first && byteLength(render(first.message)) <= budgetBytes) {
    chosen.add(first.index);
    used += byteLength(render(first.message));
  }
  for (let position = usable.length - 1; position >= 0; position -= 1) {
    const { message, index } = usable[position]!;
    if (chosen.has(index)) continue;
    const size = byteLength(render(message));
    if (used + size > budgetBytes) break;
    chosen.add(index);
    used += size;
  }
  const indexes = [...chosen].sort((left, right) => left - right);
  return { indexes, omitted: usable.length - indexes.length };
}

export function buildMoveMessage(input: {
  readonly title: string;
  readonly fromMachine: string;
  readonly toMachine: string;
  readonly branch: string;
  readonly messages: ReadonlyArray<MoveContextMessage>;
  readonly budgetBytes?: number;
}): string {
  const { indexes, omitted } = selectMoveHistory(
    input.messages,
    input.budgetBytes ?? MOVE_CONTEXT_BUDGET_BYTES,
  );
  const history = indexes.map((index) => render(input.messages[index]!)).join("\n\n");
  return [
    `This thread ("${input.title}") was moved here from ${input.fromMachine} to ${input.toMachine}.`,
    `This worktree is on branch ${input.branch} and already holds all of the work from ${input.fromMachine}, including changes that were not committed there (the move committed them as the latest commit, "WIP: move to ${input.toMachine}").`,
    "",
    omitted > 0
      ? `Earlier conversation, oldest first (${omitted} message${omitted === 1 ? "" : "s"} in the middle omitted):`
      : "Earlier conversation, oldest first:",
    "",
    history,
    "",
    "Continue from where the conversation left off. If the last request was already finished, say briefly what state the work is in and wait for the next instruction.",
  ].join("\n");
}
