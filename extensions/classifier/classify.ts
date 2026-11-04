import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type {
  ChatReviewConfig,
  ClassifierStrategy,
} from "../../src/shared/config";
import type {
  DelegationContext,
  DelegationRequest,
} from "../../src/shared/delegation";
import {
  type ChatReviewCallOptions,
  resolveChatModel,
  reviewWithChatModel,
} from "./chat";
import { type ContextMessage, collectTaskContext } from "./context";
import {
  type ClassifierDecision,
  type ClassifierOutcome,
  decide,
  unavailable,
} from "./decision";
import { buildClassifierRequest, type ClassifierRequest } from "./requests";

type ModelRegistry = ExtensionContext["modelRegistry"];

type Registry = Pick<
  ModelRegistry,
  "getModelOfType" | "classify" | "streamSimple"
>;

/**
 * How a configured model is reached. `classifier` models answer through Pi's
 * classify API; `chat` models answer the same rubric as JSON.
 */
export type ReviewModelKind = "classifier" | "chat";

export interface ModelRef {
  provider: string;
  model: string;
}

export function parseModelRef(value: string): ModelRef | undefined {
  const trimmed = value.trim();
  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash === trimmed.length - 1) return undefined;
  return {
    provider: trimmed.slice(0, slash),
    model: trimmed.slice(slash + 1),
  };
}

export interface ModelRun {
  model: string;
  decision: ClassifierDecision;
  elapsedMs: number;
}

function errorText(error: unknown): string {
  const text =
    error instanceof Error ? error.message : String(error ?? "unknown error");
  return text.length > 200 ? `${text.slice(0, 199)}…` : text;
}

export async function classifyWithModel(
  registry: Registry,
  ref: ModelRef,
  request: ClassifierRequest,
  hasTaskContext: boolean,
  signal: AbortSignal,
): Promise<ModelRun> {
  const label = `${ref.provider}/${ref.model}`;
  const startedAt = performance.now();
  const done = (decision: ClassifierDecision): ModelRun => ({
    model: label,
    decision,
    elapsedMs: Math.round(performance.now() - startedAt),
  });

  let model: ReturnType<Registry["getModelOfType"]>;
  try {
    model = registry.getModelOfType("classifier", ref.provider, ref.model);
  } catch (error) {
    return done(
      unavailable(`${label} could not be resolved: ${errorText(error)}`),
    );
  }
  if (!model) return done(unavailable(`${label} is not available`));

  try {
    const outcome = await registry.classify(model, request, { signal });
    return done(decide(outcome as ClassifierOutcome, { hasTaskContext }));
  } catch (error) {
    return done(unavailable(`${label} failed: ${errorText(error)}`));
  }
}

/** Which review API a configured model ref reaches. */
export function resolveReviewModelKind(
  registry: Registry,
  ref: ModelRef,
): ReviewModelKind | undefined {
  const isListed = (type: ReviewModelKind): boolean => {
    try {
      return (
        registry.getModelOfType(type, ref.provider, ref.model) !== undefined
      );
    } catch {
      // A provider the registry cannot resolve lists nothing; the caller
      // reports the ref as unavailable.
      return false;
    }
  };

  if (isListed("classifier")) return "classifier";
  if (isListed("chat")) return "chat";
  return undefined;
}

/**
 * Ask one configured model. A model listed as a classifier keeps the classify
 * API, which is cheaper and returns measured probabilities; otherwise the ref
 * is treated as a cloud chat model and answers the same rubric as JSON.
 */
export async function reviewWithModel(
  registry: Registry,
  ref: ModelRef,
  request: ClassifierRequest,
  hasTaskContext: boolean,
  signal: AbortSignal,
  chat: ChatReviewCallOptions = {},
): Promise<ModelRun> {
  const label = `${ref.provider}/${ref.model}`;

  if (resolveReviewModelKind(registry, ref) === "classifier") {
    return classifyWithModel(registry, ref, request, hasTaskContext, signal);
  }

  const resolved = resolveChatModel(registry, ref.provider, ref.model);
  if (!resolved) {
    return {
      model: label,
      decision: unavailable(`${label} is not available`),
      elapsedMs: 0,
    };
  }

  const run = await reviewWithChatModel(
    registry,
    label,
    resolved.model,
    request,
    hasTaskContext,
    signal,
    chat,
  );
  return { model: label, ...run };
}

function shuffled<T>(items: readonly T[], random: () => number): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j] as T, copy[i] as T];
  }
  return copy;
}

export function combineRuns(runs: readonly ModelRun[]): ModelRun | undefined {
  const blocked = runs.find((run) => run.decision.verdict === "block");
  if (blocked) return blocked;
  if (
    runs.length > 0 &&
    runs.every((run) => run.decision.verdict === "allow")
  ) {
    return runs[0];
  }
  return runs.find((run) => run.decision.verdict === "ask");
}

export interface ClassifierAnswerDetails {
  strategy: ClassifierStrategy;
  runs: ModelRun[];
}

export interface ClassifierAnswer {
  verdict: ClassifierDecision["verdict"];
  reason: string;
  details: ClassifierAnswerDetails;
}

export interface RunClassifierOptions {
  models: readonly string[];
  strategy: ClassifierStrategy;
  /** Options for the models configured as chat reviewers. */
  chat?: ChatReviewConfig | ChatReviewCallOptions;
  random?: () => number;
}

export async function runClassifier(
  request: DelegationRequest,
  context: Pick<
    DelegationContext,
    "cwd" | "signal" | "modelRegistry" | "sessionManager"
  >,
  options: RunClassifierOptions,
): Promise<ClassifierAnswer | undefined> {
  const refs = options.models
    .map(parseModelRef)
    .filter((ref): ref is ModelRef => ref !== undefined);
  if (refs.length === 0) return undefined;

  const messages = context.sessionManager.buildSessionProjection()
    .messages as readonly ContextMessage[];
  const taskContext = collectTaskContext(messages);
  const classifierRequest = buildClassifierRequest({
    action: request.action,
    toolName: request.toolName,
    cwd: context.cwd,
    userRequests: taskContext.userRequests,
    ...(taskContext.agentClaim ? { agentClaim: taskContext.agentClaim } : {}),
    flaggedReason: request.reason,
  });
  const hasTaskContext = taskContext.userRequests.length > 0;
  const run = (ref: ModelRef) =>
    reviewWithModel(
      context.modelRegistry,
      ref,
      classifierRequest,
      hasTaskContext,
      context.signal,
      options.chat,
    );

  const runs: ModelRun[] = [];
  let chosen: ModelRun | undefined;

  if (options.strategy === "consensus") {
    const settled = await Promise.all(refs.map(run));
    runs.push(...settled);
    chosen = combineRuns(runs);
  } else {
    const order =
      options.strategy === "random"
        ? shuffled(refs, options.random ?? Math.random)
        : refs;
    for (const ref of order) {
      if (context.signal.aborted) break;
      const result = await run(ref);
      runs.push(result);
      if (result.decision.code !== "escalate-unavailable") {
        chosen = result;
        break;
      }
    }
    chosen ??= runs.at(-1);
  }

  if (!chosen) return undefined;
  const prefix = refs.length > 1 ? `${chosen.model}: ` : "";
  return {
    verdict: chosen.decision.verdict,
    reason: `${prefix}${chosen.decision.reason}`,
    details: { strategy: options.strategy, runs },
  };
}
