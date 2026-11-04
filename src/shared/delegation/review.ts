import type { DelegatedDecision } from "./types";

/**
 * What the decision delegates said, as one plain-text line. Features show this
 * wherever an action still needs the user: the confirm prompt, its select
 * fallback, and a headless block.
 */
export function describeReview(
  delegated?: DelegatedDecision,
): string | undefined {
  if (!delegated) return undefined;
  const seconds = (delegated.elapsedMs / 1000).toFixed(1);
  return `Model review (${seconds}s): ${delegated.reason}`;
}
