import { describe, expect, it, vi } from "vitest";
import type { DelegationRequest } from "../../src/shared/delegation";
import {
  combineRuns,
  type ModelRun,
  parseModelRef,
  resolveReviewModelKind,
  reviewWithModel,
  runClassifier,
} from "./classify";
import type { ClassifierOutcome } from "./decision";
import { buildClassifierRequest } from "./requests";

const request: DelegationRequest = {
  feature: "permissionGate",
  action: { kind: "command", command: "rm -rf node_modules", origin: "bash" },
  reason: "recursive force delete",
  toolName: "bash",
  input: { command: "rm -rf node_modules" },
};

function outcome(
  authorization: "in_scope" | "unclear" | "out_of_scope",
  impact: number,
): ClassifierOutcome {
  return {
    stopReason: "stop",
    answers: {
      context_sufficiency: { type: "bool", probability: 0.95 },
      authorization: {
        type: "choice",
        choice: authorization,
        probabilities: { [authorization]: 0.95 },
      },
      impact: { type: "score", score: impact, confidence: 0.9 },
    },
  };
}

const ALLOW = outcome("in_scope", 1);
const ASK = outcome("unclear", 1);
const BLOCK = outcome("out_of_scope", 3);

function context(
  responses: Record<string, ClassifierOutcome | Error | undefined>,
  messages: unknown[] = [{ role: "user", content: "clean deps" }],
) {
  const classify = vi.fn(async (model: { id: string }) => {
    const response = responses[model.id];
    if (response instanceof Error) throw response;
    return response as ClassifierOutcome;
  });
  const getModelOfType = vi.fn(
    (_type: string, provider: string, model: string) => {
      const id = `${provider}/${model}`;
      return id in responses && responses[id] !== undefined
        ? { id }
        : undefined;
    },
  );
  return {
    cwd: "/workspace",
    signal: new AbortController().signal,
    modelRegistry: { classify, getModelOfType } as never,
    sessionManager: {
      buildSessionProjection: () => ({ messages }),
    } as never,
    classify,
  };
}

const CHAT_ALLOW = JSON.stringify({
  context_sufficiency: { answer: true, confidence: 0.9 },
  authorization: { answer: "in_scope", confidence: 0.9 },
  impact: { answer: 1, confidence: 0.9 },
  explanation: "removes generated dependencies",
});

/**
 * A registry where `classifier` refs come from `classifierRefs` and `chat`
 * refs from `chatRefs`; `chatAnswers` decides what each chat model replies.
 */
function mixedContext(options: {
  classifierRefs?: Record<string, ClassifierOutcome | Error | undefined>;
  chatRefs?: string[];
  chatAnswers?: Record<string, string | Error>;
  messages?: unknown[];
}) {
  const classifierRefs = options.classifierRefs ?? {};
  const chatRefs = options.chatRefs ?? [];
  const chatAnswers = options.chatAnswers ?? {};

  const classify = vi.fn(async (model: { id: string }) => {
    const response = classifierRefs[model.id];
    if (response instanceof Error) throw response;
    return response as ClassifierOutcome;
  });
  const streamSimple = vi.fn(
    (
      model: { id: string },
      _context: unknown,
      _options: { maxTokens?: number; reasoning?: string },
    ) => {
      const answer = chatAnswers[model.id];
      if (answer instanceof Error) throw answer;
      const text = answer ?? "no answer";
      return {
        result: async () => ({
          content: [{ type: "text", text }],
          stopReason: "stop",
        }),
      };
    },
  );
  const getModelOfType = vi.fn(
    (type: string, _provider: string, id: string) => {
      if (type === "classifier") {
        return id in classifierRefs && classifierRefs[id] !== undefined
          ? { id }
          : undefined;
      }
      return chatRefs.includes(id) ? { id } : undefined;
    },
  );

  return {
    cwd: "/workspace",
    signal: new AbortController().signal,
    modelRegistry: { getModelOfType, classify, streamSimple } as never,
    sessionManager: {
      buildSessionProjection: () => ({
        messages: options.messages ?? [{ role: "user", content: "clean deps" }],
      }),
      getSessionId: () => "session-1",
    } as never,
    classify,
    streamSimple,
  };
}

describe("resolveReviewModelKind", () => {
  it("prefers the classifier API for a model listed as one", () => {
    const ctx = mixedContext({
      classifierRefs: { jev: ALLOW },
      chatRefs: ["jev"],
    });
    expect(
      resolveReviewModelKind(ctx.modelRegistry, {
        provider: "typesafe",
        model: "jev",
      }),
    ).toBe("classifier");
  });

  it("treats a chat-only model as a chat reviewer", () => {
    const ctx = mixedContext({ chatRefs: ["gemini"] });
    expect(
      resolveReviewModelKind(ctx.modelRegistry, {
        provider: "google",
        model: "gemini",
      }),
    ).toBe("chat");
  });

  it("resolves nothing for an unknown model", () => {
    const ctx = mixedContext({});
    expect(
      resolveReviewModelKind(ctx.modelRegistry, {
        provider: "google",
        model: "nope",
      }),
    ).toBeUndefined();
  });
});

describe("reviewWithModel", () => {
  it("keeps the classify API for classifier models", async () => {
    const ctx = mixedContext({ classifierRefs: { jev: ALLOW } });
    const run = await reviewWithModel(
      ctx.modelRegistry,
      { provider: "typesafe", model: "jev" },
      buildClassifierRequest({
        action: request.action,
        toolName: "bash",
        cwd: "/workspace",
        userRequests: ["clean deps"],
        flaggedReason: request.reason,
      }),
      true,
      new AbortController().signal,
    );
    expect(run.decision.verdict).toBe("allow");
    expect(ctx.classify).toHaveBeenCalledTimes(1);
    expect(ctx.streamSimple).not.toHaveBeenCalled();
  });

  it("asks a cloud chat model the same rubric", async () => {
    const ctx = mixedContext({
      chatRefs: ["gemini"],
      chatAnswers: { gemini: CHAT_ALLOW },
    });
    const run = await reviewWithModel(
      ctx.modelRegistry,
      { provider: "google", model: "gemini" },
      buildClassifierRequest({
        action: request.action,
        toolName: "bash",
        cwd: "/workspace",
        userRequests: ["clean deps"],
        flaggedReason: request.reason,
      }),
      true,
      new AbortController().signal,
      { maxTokens: 512, reasoning: "off" },
    );
    expect(run.model).toBe("google/gemini");
    expect(run.decision.verdict).toBe("allow");
    expect(ctx.classify).not.toHaveBeenCalled();
    expect(ctx.streamSimple.mock.calls[0]?.[2]).toEqual({
      maxTokens: 512,
      reasoning: "off",
    });
  });

  it("escalates for a model the catalogue does not have", async () => {
    const ctx = mixedContext({});
    const run = await reviewWithModel(
      ctx.modelRegistry,
      { provider: "google", model: "missing" },
      buildClassifierRequest({
        action: request.action,
        toolName: "bash",
        cwd: "/workspace",
        userRequests: ["clean deps"],
        flaggedReason: request.reason,
      }),
      true,
      new AbortController().signal,
    );
    expect(run.decision.code).toBe("escalate-unavailable");
    expect(run.decision.reason).toContain("is not available");
  });
});

describe("parseModelRef", () => {
  it.each([
    ["typesafe/jev-latest", { provider: "typesafe", model: "jev-latest" }],
    [
      "aperture/typesafe/jev-latest",
      { provider: "aperture", model: "typesafe/jev-latest" },
    ],
    ["  cfm/clef  ", { provider: "cfm", model: "clef" }],
    ["no-slash", undefined],
    ["/model", undefined],
    ["provider/", undefined],
  ])("parses %j", (value, expected) => {
    expect(parseModelRef(value)).toEqual(expected);
  });
});

describe("runClassifier", () => {
  it("abstains when no configured model parses", async () => {
    const ctx = context({});
    await expect(
      runClassifier(request, ctx, { models: ["bad"], strategy: "fallback" }),
    ).resolves.toBeUndefined();
  });

  it("sends the flagged action, user requests, and guardrail flag", async () => {
    const ctx = context({ "p/a": ALLOW });
    await runClassifier(request, ctx, {
      models: ["p/a"],
      strategy: "fallback",
    });
    const [, sent] = ctx.classify.mock.calls[0] as unknown as [
      unknown,
      { state: Record<string, unknown> },
    ];
    expect(sent.state).toMatchObject({
      action: { kind: "bash command", command: "rm -rf node_modules" },
      task_context: { user_requests: ["clean deps"] },
      guardrail_flag: "recursive force delete",
    });
  });

  it("asks without a user request in the session", async () => {
    const ctx = context({ "p/a": ALLOW }, []);
    const answer = await runClassifier(request, ctx, {
      models: ["p/a"],
      strategy: "fallback",
    });
    expect(answer?.verdict).toBe("ask");
  });

  describe("fallback", () => {
    it("uses the first model that answers", async () => {
      const ctx = context({
        "p/missing": undefined,
        "p/broken": new Error("503"),
        "p/good": ALLOW,
        "p/never": BLOCK,
      });
      const answer = await runClassifier(request, ctx, {
        models: ["p/missing", "p/broken", "p/good", "p/never"],
        strategy: "fallback",
      });
      expect(answer?.verdict).toBe("allow");
      expect(answer?.reason).toMatch(/^p\/good: in scope/);
      expect(answer?.details.runs.map((run) => run.model)).toEqual([
        "p/missing",
        "p/broken",
        "p/good",
      ]);
    });

    it("asks when no model can answer", async () => {
      const ctx = context({ "p/a": new Error("down") });
      const answer = await runClassifier(request, ctx, {
        models: ["p/a"],
        strategy: "fallback",
      });
      expect(answer).toMatchObject({ verdict: "ask" });
      expect(answer?.reason).toContain("down");
    });

    it("does not fall through on a real ask", async () => {
      const ctx = context({ "p/a": ASK, "p/b": ALLOW });
      const answer = await runClassifier(request, ctx, {
        models: ["p/a", "p/b"],
        strategy: "fallback",
      });
      expect(answer?.verdict).toBe("ask");
      expect(ctx.classify).toHaveBeenCalledTimes(1);
    });
  });

  it("falls from an unavailable classifier to a chat model", async () => {
    const ctx = mixedContext({
      classifierRefs: { jev: new Error("no key") },
      chatRefs: ["gemini"],
      chatAnswers: { gemini: CHAT_ALLOW },
    });
    const answer = await runClassifier(request, ctx, {
      models: ["typesafe/jev", "google/gemini"],
      strategy: "fallback",
      chat: { maxTokens: 512, reasoning: "off", instructions: "" },
    });
    expect(answer?.verdict).toBe("allow");
    expect(answer?.reason).toContain("google/gemini: in scope");
    expect(answer?.details.runs.map((run) => run.model)).toEqual([
      "typesafe/jev",
      "google/gemini",
    ]);
    expect(ctx.streamSimple.mock.calls[0]?.[2]).toEqual({
      maxTokens: 512,
      reasoning: "off",
      sessionId: "session-1",
    });
  });

  it("asks when a chat model answers with prose instead of JSON", async () => {
    const ctx = mixedContext({
      chatRefs: ["gemini"],
      chatAnswers: { gemini: "this looks fine" },
    });
    const answer = await runClassifier(request, ctx, {
      models: ["google/gemini"],
      strategy: "fallback",
    });
    expect(answer?.verdict).toBe("ask");
    expect(answer?.reason).toContain("no JSON object");
  });

  it("consensus mixes classifier and chat models", async () => {
    const ctx = mixedContext({
      classifierRefs: { jev: ALLOW },
      chatRefs: ["gemini"],
      chatAnswers: { gemini: CHAT_ALLOW },
    });
    const answer = await runClassifier(request, ctx, {
      models: ["typesafe/jev", "google/gemini"],
      strategy: "consensus",
    });
    expect(answer?.verdict).toBe("allow");
    expect(ctx.classify).toHaveBeenCalledTimes(1);
    expect(ctx.streamSimple).toHaveBeenCalledTimes(1);
  });

  it("random starts from a shuffled model", async () => {
    const ctx = context({ "p/a": ALLOW, "p/b": BLOCK });
    const answer = await runClassifier(request, ctx, {
      models: ["p/a", "p/b"],
      strategy: "random",
      random: () => 0,
    });
    expect(answer?.verdict).toBe("block");
    expect(ctx.classify).toHaveBeenCalledTimes(1);
  });

  describe("consensus", () => {
    it("allows only when every model allows", async () => {
      const ctx = context({ "p/a": ALLOW, "p/b": ALLOW });
      const answer = await runClassifier(request, ctx, {
        models: ["p/a", "p/b"],
        strategy: "consensus",
      });
      expect(answer?.verdict).toBe("allow");
    });

    it("blocks when any model blocks", async () => {
      const ctx = context({ "p/a": ALLOW, "p/b": BLOCK, "p/c": ASK });
      const answer = await runClassifier(request, ctx, {
        models: ["p/a", "p/b", "p/c"],
        strategy: "consensus",
      });
      expect(answer?.verdict).toBe("block");
    });

    it("asks when any model asks or is unavailable", async () => {
      const unavailable = context({ "p/a": ALLOW, "p/b": undefined });
      const answer = await runClassifier(request, unavailable, {
        models: ["p/a", "p/b"],
        strategy: "consensus",
      });
      expect(answer?.verdict).toBe("ask");
    });
  });
});

describe("combineRuns", () => {
  const run = (verdict: "allow" | "ask" | "block"): ModelRun => ({
    model: verdict,
    elapsedMs: 1,
    decision: { verdict, code: "approved", reason: verdict, facts: {} },
  });

  it("returns nothing for no runs", () => {
    expect(combineRuns([])).toBeUndefined();
  });

  it("prefers block, then requires unanimous allow", () => {
    expect(combineRuns([run("allow"), run("block")])?.model).toBe("block");
    expect(combineRuns([run("allow"), run("allow")])?.model).toBe("allow");
    expect(combineRuns([run("allow"), run("ask")])?.model).toBe("ask");
  });
});
