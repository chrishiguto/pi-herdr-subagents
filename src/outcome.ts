export const MAX_OUTCOME_CHARS = 12_000;

export interface BoundedText {
  text: string;
  truncated: boolean;
  originalChars: number;
}

/** Bound untrusted child output before it can enter the orchestrator context. */
export function boundOutcomeText(text: string, maxChars = MAX_OUTCOME_CHARS): BoundedText {
  if (text.length <= maxChars) {
    return { text, truncated: false, originalChars: text.length };
  }

  const marker = "\n\n… [output truncated] …\n\n";
  const contentBudget = Math.max(0, maxChars - marker.length);
  const headChars = Math.ceil(contentBudget * 0.75);
  const tailChars = contentBudget - headChars;
  return {
    text: text.slice(0, headChars) + marker + (tailChars > 0 ? text.slice(-tailChars) : ""),
    truncated: true,
    originalChars: text.length,
  };
}
