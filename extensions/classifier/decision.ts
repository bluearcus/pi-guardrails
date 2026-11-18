import type { DelegateVerdict } from "../../src/core/delegation";
import { AUTHORIZATION_LABELS, type AuthorizationLabel } from "./requests";

export const TRUST_CONFIDENCE = 0.7;
export const ALLOW_CONFIDENCE = 0.85;
export const DESTRUCTIVE_IMPACT = 2.5;
export const BLOCK_IMPACT = 2;
/** Impact levels 0 and 1: trivially reversible, or confined to the workspace. */
export const UNREQUESTED_IMPACT = 1.5;

/** The thresholds every reviewer is judged by unless a caller overrides one. */
export interface DecisionThresholds {
  trust: number;
  allow: number;
  destructiveImpact: number;
  blockImpact: number;
  /**
   * Impact below which a step your request does not name is still acted on.
   * Clearing a scratch directory or replacing build output is judged by its
   * effect, not by whether you asked for housekeeping. Set to 0 to require
   * scope for everything.
   */
  unrequestedImpact: number;
}

export const DEFAULT_THRESHOLDS: DecisionThresholds = {
  trust: TRUST_CONFIDENCE,
  allow: ALLOW_CONFIDENCE,
  destructiveImpact: DESTRUCTIVE_IMPACT,
  blockImpact: BLOCK_IMPACT,
  unrequestedImpact: UNREQUESTED_IMPACT,
};

export type ClassifierDecisionCode =
  | "approved"
  | "approved-unrequested"
  | "escalate-insufficient-context"
  | "escalate-ambiguous"
  | "escalate-destructive"
  | "escalate-low-confidence"
  | "escalate-unavailable"
  | "blocked-out-of-scope";

export interface ClassifierFacts {
  contextSufficiency?: number;
  authorization?: { label: AuthorizationLabel; probability: number };
  impact?: { level: number; confidence: number };
}

export interface ClassifierDecision {
  verdict: DelegateVerdict;
  code: ClassifierDecisionCode;
  reason: string;
  facts: ClassifierFacts;
}

export interface ClassifierOutcome {
  stopReason: string;
  errorMessage?: string;
  answers?: Record<string, AnswerLike>;
}

type ChoiceAnswer = {
  type: "choice";
  choice: string;
  probabilities?: Record<string, number>;
  confidence?: number;
};
type BoolAnswer = { type: "bool"; probability: number };
type ScoreAnswer = { type: "score"; score: number; confidence: number };
type AnswerLike = ChoiceAnswer | BoolAnswer | ScoreAnswer;

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function percent(value: number): string {
  return `${Math.round(clamp01(value) * 100)}%`;
}

export function unavailable(
  detail: string,
  facts: ClassifierFacts = {},
): ClassifierDecision {
  return {
    verdict: "ask",
    code: "escalate-unavailable",
    reason: `could not review this (${detail})`,
    facts,
  };
}

function readAuthorization(
  answer: AnswerLike | undefined,
): { label: AuthorizationLabel; probability: number } | null {
  if (answer?.type !== "choice") return null;
  if (!(AUTHORIZATION_LABELS as readonly string[]).includes(answer.choice)) {
    return null;
  }
  const label = answer.choice as AuthorizationLabel;
  const fromProbabilities = answer.probabilities?.[label];
  const probability = finite(fromProbabilities)
    ? fromProbabilities
    : finite(answer.confidence)
      ? answer.confidence
      : Number.NaN;
  if (!finite(probability)) return null;
  return { label, probability: clamp01(probability) };
}

function readBool(answer: AnswerLike | undefined): number | null {
  if (answer?.type !== "bool") return null;
  if (!finite(answer.probability)) return null;
  return clamp01(answer.probability);
}

function readScore(
  answer: AnswerLike | undefined,
): { level: number; confidence: number } | null {
  if (answer?.type !== "score") return null;
  if (!finite(answer.score) || !finite(answer.confidence)) return null;
  return {
    level: Math.min(4, Math.max(0, answer.score)),
    confidence: clamp01(answer.confidence),
  };
}

export interface DecideOptions {
  hasTaskContext: boolean;
  /**
   * Replace a threshold for this review. A chat model rates its own answers, so
   * a reviewer can ask for a looser bar than the measured classifier
   * probabilities get. Anything omitted keeps the built-in value.
   */
  thresholds?: Partial<DecisionThresholds>;
}

export function decide(
  outcome: ClassifierOutcome,
  options: DecideOptions,
): ClassifierDecision {
  const thresholds: DecisionThresholds = {
    ...DEFAULT_THRESHOLDS,
    ...(options.thresholds ?? {}),
  };
  const facts: ClassifierFacts = {};

  if (outcome.stopReason !== "stop") {
    return unavailable(
      outcome.stopReason === "aborted"
        ? "request aborted or timed out"
        : (outcome.errorMessage ?? outcome.stopReason),
    );
  }

  if (!options.hasTaskContext) {
    return {
      verdict: "ask",
      code: "escalate-insufficient-context",
      reason: "no earlier user request to judge this against",
      facts,
    };
  }

  const sufficiency = readBool(outcome.answers?.context_sufficiency);
  if (sufficiency === null) return unavailable("missing sufficiency answer");
  facts.contextSufficiency = sufficiency;

  const authorization = readAuthorization(outcome.answers?.authorization);
  if (!authorization) {
    return unavailable("missing or invalid authorization answer", facts);
  }
  facts.authorization = authorization;

  const impact = readScore(outcome.answers?.impact);
  if (!impact) return unavailable("missing or invalid impact answer", facts);
  facts.impact = impact;

  const impactText = `impact ${impact.level.toFixed(1)}/4`;

  if (
    authorization.label === "out_of_scope" &&
    authorization.probability >= thresholds.trust
  ) {
    if (impact.level >= thresholds.blockImpact) {
      return {
        verdict: "block",
        code: "blocked-out-of-scope",
        reason: `not covered by your request, ${impactText}`,
        facts,
      };
    }
    return {
      verdict: "ask",
      code: "escalate-ambiguous",
      reason: `does not clearly follow from your request, but ${impactText} is low`,
      facts,
    };
  }

  if (authorization.label === "unclear") {
    // A step your request does not name is not a step that exceeds it. When the
    // effect is trivially reversible there is nothing to protect by asking, and
    // the question is asked on every cleanup the agent does.
    if (
      sufficiency >= thresholds.trust &&
      impact.level < thresholds.unrequestedImpact
    ) {
      return {
        verdict: "allow",
        code: "approved-unrequested",
        reason: `your request does not name this, but ${impactText} is easy to undo`,
        facts,
      };
    }
    return {
      verdict: "ask",
      code: "escalate-ambiguous",
      reason: "unclear whether your request covers this",
      facts,
    };
  }

  if (authorization.label === "out_of_scope") {
    return {
      verdict: "ask",
      code: "escalate-low-confidence",
      reason: `your request probably does not cover this, but only ${percent(authorization.probability)} sure`,
      facts,
    };
  }

  if (sufficiency < thresholds.trust) {
    return {
      verdict: "ask",
      code: "escalate-insufficient-context",
      reason: `not enough of your request on hand to judge this (${percent(sufficiency)})`,
      facts,
    };
  }

  if (impact.level >= thresholds.destructiveImpact) {
    return {
      verdict: "ask",
      code: "escalate-destructive",
      reason: `your request covers this, but ${impactText} is hard to undo`,
      facts,
    };
  }

  if (
    sufficiency >= thresholds.allow &&
    authorization.probability >= thresholds.allow
  ) {
    return {
      verdict: "allow",
      code: "approved",
      reason: `your request covers this, ${impactText}`,
      facts,
    };
  }

  return {
    verdict: "ask",
    code: "escalate-low-confidence",
    reason: `your request probably covers this, but only ${percent(Math.min(sufficiency, authorization.probability))} sure`,
    facts,
  };
}
