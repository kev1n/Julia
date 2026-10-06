/** `Claude Max 20x Subscription` → `Max 20x`; `ChatGPT Plus Subscription` → `Plus`. */
export function shortPlanLabel(plan: string | undefined): string | null {
  const short = plan
    ?.trim()
    .replace(/^(Claude|ChatGPT)\s+/i, "")
    .replace(/\s+Subscription$/i, "")
    .trim();
  return short ? short : null;
}
