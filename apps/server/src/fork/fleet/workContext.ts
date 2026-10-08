/** Keep goals and findings bounded; generated alerts are not user intent. */
export function workContext(
  users: ReadonlyArray<{ readonly text: string }>,
  findings: ReadonlyArray<{ readonly text: string }>,
) {
  const useful = users.filter(
    ({ text }) =>
      text.trim() !== "" &&
      !/^\s*(\[Fleet overlap (?:alert|note)\]|\[Historical |Context handoff)/.test(text),
  );
  const selected = useful.length > 3 ? [useful[0]!, ...useful.slice(-3)] : useful;
  return [
    ...selected.map(({ text }) => `User: ${text.slice(0, 1400)}`),
    ...findings
      .filter(({ text }) => text.trim() !== "")
      .slice(-2)
      .map(({ text }) => `Agent: ${text.slice(-1400)}`),
  ]
    .join("\n")
    .slice(0, 8400);
}
