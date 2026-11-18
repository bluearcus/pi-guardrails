import type {
  BashToolCallEvent,
  ExtensionAPI,
  ExtensionContext,
  ExtensionHandler,
  ReadToolCallEvent,
  ToolCallEvent,
  ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";
import {
  createMock,
  type DeepMocked,
  type PartialFuncReturn,
} from "@golevelup/ts-vitest";
import { assert, beforeEach, describe, expect, it, vi } from "vitest";
import { configLoader, type ResolvedConfig } from "../../src/shared/config";
import {
  GUARDRAILS_ACTION_BLOCKED_EVENT,
  GUARDRAILS_FEATURE_REGISTER_EVENT,
  GUARDRAILS_FEATURE_REQUEST_EVENT,
  GUARDRAILS_PROMPT_CLOSED_EVENT,
  GUARDRAILS_PROMPT_OPENED_EVENT,
  type GuardrailsPromptOpenedPayload,
} from "../../src/shared/events";
import { answerFor } from "../../tests/utils/prompt-answers";
import permissionGate from "./index";

function makeConfig(overrides: Record<string, unknown> = {}): ResolvedConfig {
  // Partial on purpose: the hook under test only reads the fields below.
  return {
    enabled: true,
    features: { permissionGate: true, policies: true, pathAccess: true },
    delegation: { timeoutMs: 1000 },
    permissionGate: {
      patterns: [{ pattern: "dangerous-cmd", description: "test danger" }],
      useBuiltinMatchers: false,
      requireConfirmation: true,
      allowedPatterns: [],
      autoDenyPatterns: [],
      grants: [],
      alwaysScope: "local",
      scratchDelete: { enabled: true, roots: ["/tmp"] },
      customPatterns: undefined,
      ...overrides,
    },
  } as unknown as ResolvedConfig;
}

// Control the config the hook sees without touching the real config loader.
vi.mock("../../src/shared/config", () => {
  return {
    configLoader: {
      load: vi.fn().mockResolvedValue(undefined),
      getConfig: vi.fn(() => makeConfig()),
      getRawConfig: vi.fn(() => null),
      getScopePath: vi.fn(() => null),
      getProjectState: vi.fn(() => "trusted"),
      save: vi.fn().mockResolvedValue(undefined),
    },
  };
});

type ToolCallHandler = ExtensionHandler<ToolCallEvent, ToolCallEventResult>;

function registeredToolCallHandler(pi: DeepMocked<ExtensionAPI>) {
  const calls: unknown[][] = pi.on.mock.calls;
  return calls.find(([event]) => event === "tool_call")?.[1] as
    | ToolCallHandler
    | undefined;
}

const WORKING_DIR = "/home/mike/project";

function createCtx(overrides: PartialFuncReturn<ExtensionContext> = {}) {
  const { ui, ...rest } = overrides;
  const { custom, ...uiRest } = ui ?? {};
  return createMock<ExtensionContext>({
    hasUI: true,
    mode: "tui",
    cwd: WORKING_DIR,
    ui: {
      custom: answerFor(custom) ?? vi.fn().mockResolvedValue(undefined),
      select: vi.fn().mockResolvedValue(undefined),
      notify: vi.fn(),
      ...uiRest,
    },
    abort: vi.fn(),
    ...rest,
  });
}

const DANGEROUS_EVENT = {
  type: "tool_call",
  toolCallId: "dangerous-call",
  toolName: "bash",
  input: { command: "dangerous-cmd" },
} satisfies BashToolCallEvent;

describe("permissionGate extension hook", () => {
  let pi: DeepMocked<ExtensionAPI>;
  let toolCallHandler: ToolCallHandler | undefined;

  beforeEach(async () => {
    vi.mocked(configLoader.getConfig).mockImplementation(() => makeConfig());
    pi = createMock<ExtensionAPI>();
    await permissionGate(pi);
    toolCallHandler = registeredToolCallHandler(pi);
  });

  it("registers the permissionGate feature on request", async () => {
    const registration = pi.events.on.mock.calls.find(
      ([event]) => event === GUARDRAILS_FEATURE_REQUEST_EVENT,
    );

    assert(registration, "feature request handler should be registered");
    registration[1](undefined);
    expect(pi.events.emit).toHaveBeenCalledWith(
      GUARDRAILS_FEATURE_REGISTER_EVENT,
      expect.objectContaining({
        feature: { id: "permissionGate" },
      }),
    );
  });

  it("returns undefined for safe commands", async () => {
    assert(toolCallHandler, "tool_call handler should be registered");

    const result = await toolCallHandler(
      {
        type: "tool_call",
        toolCallId: "safe-call",
        toolName: "bash",
        input: { command: "echo hello" },
      } satisfies BashToolCallEvent,
      createCtx(),
    );
    expect(result).toBeUndefined();
  });

  it("returns undefined for non-bash tools", async () => {
    assert(toolCallHandler, "tool_call handler should be registered");

    const result = await toolCallHandler(
      {
        type: "tool_call",
        toolCallId: "read-call",
        toolName: "read",
        input: { path: "dangerous-cmd" },
      } satisfies ReadToolCallEvent,
      createCtx(),
    );
    expect(result).toBeUndefined();
  });

  it("auto-deny returns terminate: true when the pattern opts in", async () => {
    vi.mocked(configLoader.getConfig).mockReturnValue(
      makeConfig({
        autoDenyPatterns: [
          {
            pattern: "sleep-wait",
            description: "do not sleep-wait",
            terminate: true,
          },
        ],
      }),
    );

    assert(toolCallHandler, "tool_call handler should be registered");
    const result = await toolCallHandler(
      {
        type: "tool_call",
        toolCallId: "sleep-call",
        toolName: "bash",
        input: { command: "echo sleep-wait" },
      } satisfies BashToolCallEvent,
      createCtx(),
    );

    expect(result).toEqual({
      block: true,
      reason: "Command auto-denied: do not sleep-wait",
      terminate: true,
    });
  });

  it("auto-deny without terminate keeps today's result shape", async () => {
    vi.mocked(configLoader.getConfig).mockReturnValue(
      makeConfig({
        autoDenyPatterns: [{ pattern: "sleep-wait", description: "no" }],
      }),
    );

    assert(toolCallHandler, "tool_call handler should be registered");
    const result = await toolCallHandler(
      {
        type: "tool_call",
        toolCallId: "sleep-call",
        toolName: "bash",
        input: { command: "echo sleep-wait" },
      } satisfies BashToolCallEvent,
      createCtx(),
    );

    expect(result).toEqual({
      block: true,
      reason: "Command auto-denied: no",
    });
    expect(result).not.toHaveProperty("terminate");
  });

  it("deny returns { block: true } without aborting the turn", async () => {
    assert(toolCallHandler, "tool_call handler should be registered");

    const ctx = createCtx({
      ui: { custom: vi.fn().mockResolvedValue("deny"), select: vi.fn() },
    });

    const result = await toolCallHandler(DANGEROUS_EVENT, ctx);

    expect(result).toEqual({
      block: true,
      reason: "User denied dangerous command",
    });
    expect(ctx.abort).not.toHaveBeenCalled();
    expect(pi.events.emit).toHaveBeenCalledWith(
      GUARDRAILS_ACTION_BLOCKED_EVENT,
      expect.objectContaining({
        block: expect.objectContaining({ source: "user" }),
      }),
    );
  });

  it("stop calls ctx.abort() and returns { block: true } with user-stop source", async () => {
    assert(toolCallHandler, "tool_call handler should be registered");

    const ctx = createCtx({
      ui: { custom: vi.fn().mockResolvedValue("stop"), select: vi.fn() },
    });

    const result = await toolCallHandler(DANGEROUS_EVENT, ctx);

    expect(result).toEqual({
      block: true,
      reason: "User declined and stopped dangerous command",
    });
    expect(ctx.abort).toHaveBeenCalledTimes(1);
    expect(pi.events.emit).toHaveBeenCalledWith(
      GUARDRAILS_ACTION_BLOCKED_EVENT,
      expect.objectContaining({
        block: expect.objectContaining({ source: "user-stop" }),
      }),
    );
  });

  it("allow once returns undefined and does not abort", async () => {
    assert(toolCallHandler, "tool_call handler should be registered");

    const ctx = createCtx({
      ui: { custom: vi.fn().mockResolvedValue("allow"), select: vi.fn() },
    });

    const result = await toolCallHandler(DANGEROUS_EVENT, ctx);
    expect(result).toBeUndefined();
    expect(ctx.abort).not.toHaveBeenCalled();

    const opened = pi.events.emit.mock.calls.find(
      ([event]) => event === GUARDRAILS_PROMPT_OPENED_EVENT,
    )?.[1] as GuardrailsPromptOpenedPayload | undefined;
    assert(opened, "prompt opened event should be emitted");
    expect(pi).toHaveEmitted(
      GUARDRAILS_PROMPT_CLOSED_EVENT,
      expect.objectContaining({ prompt: { id: opened.prompt.id } }),
    );
  });

  it("closes the prompt when its UI throws", async () => {
    assert(toolCallHandler, "tool_call handler should be registered");

    const ctx = createCtx({
      ui: {
        custom: vi.fn().mockRejectedValue(new Error("UI failed")),
        select: vi.fn(),
      },
    });

    await expect(toolCallHandler(DANGEROUS_EVENT, ctx)).rejects.toThrow(
      "UI failed",
    );

    const opened = pi.events.emit.mock.calls.find(
      ([event]) => event === GUARDRAILS_PROMPT_OPENED_EVENT,
    )?.[1] as GuardrailsPromptOpenedPayload | undefined;
    assert(opened, "prompt opened event should be emitted");
    expect(pi).toHaveEmitted(
      GUARDRAILS_PROMPT_CLOSED_EVENT,
      expect.objectContaining({ prompt: { id: opened.prompt.id } }),
    );
  });

  it("RPC fallback exposes 'Decline and stop' and maps it to stop", async () => {
    assert(toolCallHandler, "tool_call handler should be registered");

    const select = vi.fn().mockResolvedValue("Decline and stop");
    const ctx = createCtx({
      ui: { custom: vi.fn().mockResolvedValue(undefined), select },
    });

    const result = await toolCallHandler(DANGEROUS_EVENT, ctx);

    expect(select).toHaveBeenCalledWith(
      expect.stringContaining("test danger"),
      expect.arrayContaining([
        "Allow once",
        "Allow dangerous-cmd under ~/project this session",
        "Always allow dangerous-cmd under ~/project",
        "Deny",
        "Decline and stop",
      ]),
    );
    expect(result).toEqual({
      block: true,
      reason: "User declined and stopped dangerous command",
    });
    expect(ctx.abort).toHaveBeenCalledTimes(1);
  });

  it("RPC fallback title shows the command and what a grant would cover", async () => {
    assert(toolCallHandler, "tool_call handler should be registered");

    const select = vi.fn().mockResolvedValue("Deny");
    const ctx = createCtx({
      ui: { custom: vi.fn().mockResolvedValue(undefined), select },
    });

    await toolCallHandler(
      { ...DANGEROUS_EVENT, input: { command: "dangerous-cmd \\\n  --force" } },
      ctx,
    );

    const [title] = select.mock.calls[0] ?? [];
    expect(title).toBe(
      "Dangerous command: test danger\n\n    dangerous-cmd \\\n      --force\n\nA grant covers dangerous-cmd under ~/project only. Anywhere else still asks.",
    );
  });

  it("does not ask again for a class granted for the working directory", async () => {
    assert(toolCallHandler, "tool_call handler should be registered");
    vi.mocked(configLoader.getConfig).mockReturnValue(
      makeConfig({
        grants: [{ class: "pattern:dangerous-cmd", directory: WORKING_DIR }],
      }),
    );

    const ctx = createCtx();
    const result = await toolCallHandler(DANGEROUS_EVENT, ctx);

    expect(result).toBeUndefined();
    expect(ctx.ui.custom).not.toHaveBeenCalled();
  });

  it("asks again for the same class in a directory that was not granted", async () => {
    assert(toolCallHandler, "tool_call handler should be registered");
    vi.mocked(configLoader.getConfig).mockReturnValue(
      makeConfig({
        grants: [{ class: "pattern:dangerous-cmd", directory: "/tmp/other" }],
      }),
    );

    const ctx = createCtx({
      ui: { custom: vi.fn().mockResolvedValue("deny") },
    });
    const result = await toolCallHandler(DANGEROUS_EVENT, ctx);

    expect(result).toEqual({
      block: true,
      reason: "User denied dangerous command",
    });
  });

  it("offers no grant when one impacted directory is not askable", async () => {
    assert(toolCallHandler, "tool_call handler should be registered");
    vi.mocked(configLoader.getConfig).mockReturnValue(
      makeConfig({
        patterns: [
          { pattern: "rm -rf", description: "recursive force delete" },
        ],
        useBuiltinMatchers: true,
      }),
    );

    const select = vi.fn().mockResolvedValue("Deny");
    const ctx = createCtx({
      cwd: WORKING_DIR,
      ui: { custom: vi.fn().mockResolvedValue(undefined), select },
    });
    await toolCallHandler(
      {
        type: "tool_call",
        toolCallId: "spans-call",
        toolName: "bash",
        input: { command: "rm -rf /home/mike/project/a /home/mike/Sync/b" },
      } satisfies BashToolCallEvent,
      ctx,
    );

    const [, options] = select.mock.calls[0] ?? [];
    expect(options).toEqual(["Allow once", "Deny", "Decline and stop"]);
  });

  it("offers no grant for a delete that names no directory of its own", async () => {
    assert(toolCallHandler, "tool_call handler should be registered");
    vi.mocked(configLoader.getConfig).mockReturnValue(
      makeConfig({
        patterns: [
          { pattern: "rm -rf", description: "recursive force delete" },
        ],
        useBuiltinMatchers: true,
      }),
    );

    const select = vi.fn().mockResolvedValue("Deny");
    const ctx = createCtx({
      cwd: WORKING_DIR,
      ui: { custom: vi.fn().mockResolvedValue(undefined), select },
    });
    await toolCallHandler(
      {
        type: "tool_call",
        toolCallId: "unplaced-call",
        toolName: "bash",
        input: { command: "rm -rf $BDIR" },
      } satisfies BashToolCallEvent,
      ctx,
    );

    // The only directory it could be granted for is the one the call started in,
    // which is the whole project, so the prompt offers no grant.
    const [, options] = select.mock.calls[0] ?? [];
    expect(options).toEqual(["Allow once", "Deny", "Decline and stop"]);
  });

  it("non-interactive (no UI) blocks with nonInteractive source and does not abort", async () => {
    assert(toolCallHandler, "tool_call handler should be registered");

    const ctx = createCtx({ hasUI: false });
    const result = await toolCallHandler(DANGEROUS_EVENT, ctx);

    expect(result).toEqual({
      block: true,
      reason: expect.stringContaining("no UI to confirm"),
    });
    expect(ctx.abort).not.toHaveBeenCalled();
    expect(pi.events.emit).toHaveBeenCalledWith(
      GUARDRAILS_ACTION_BLOCKED_EVENT,
      expect.objectContaining({
        block: expect.objectContaining({ source: "nonInteractive" }),
      }),
    );
  });
});
