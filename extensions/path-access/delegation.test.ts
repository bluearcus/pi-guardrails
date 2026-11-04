import {
  createEventBus,
  type ExtensionAPI,
  type ExtensionContext,
  type ToolCallEvent,
} from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DELEGATION_ENTRY_TYPE,
  type GuardrailsDelegate,
  registerDelegate,
} from "../../src/shared/delegation";
import pathAccess from "./index";

const state: { mode: "ask" | "block" } = { mode: "ask" };

vi.mock("../../src/shared/config", () => ({
  configLoader: {
    load: vi.fn(async () => undefined),
    getProjectState: vi.fn(() => "trusted"),
    getConfig: vi.fn(() => ({
      enabled: true,
      features: { pathAccess: true },
      delegation: { timeoutMs: 1000 },
      pathAccess: {
        mode: state.mode,
        applyTo: "all",
        allowedPaths: [],
        alwaysScope: "local",
      },
    })),
    getRawConfig: vi.fn(() => null),
    save: vi.fn(async () => undefined),
  },
}));

vi.mock("./dynamic-resources", () => ({
  piDocumentationPaths: vi.fn(() => []),
}));

vi.mock("./targets", () => ({
  targetsForTool: vi.fn(async () => ["/outside/a.txt", "/outside/b.txt"]),
  isReadOnlyTool: vi.fn(() => true),
}));

async function setup(decide?: GuardrailsDelegate["decide"]) {
  const bus = createEventBus();
  const handlers = new Map<string, (...args: never[]) => unknown>();
  const appendEntry = vi.fn();
  const pi = {
    events: bus,
    on: vi.fn((event: string, handler: (...args: never[]) => unknown) => {
      handlers.set(event, handler);
    }),
    appendEntry,
    registerEntryRenderer: vi.fn(),
  } as unknown as ExtensionAPI;

  const decideSpy = vi.fn(decide);
  await pathAccess(pi);
  if (decide) {
    registerDelegate(pi, { id: "test", name: "test", decide: decideSpy });
  }

  const custom = vi.fn(async () => "allow-file-once");
  const ctx = {
    cwd: "/workspace",
    hasUI: true,
    mode: "tui",
    signal: undefined,
    sessionManager: {},
    modelRegistry: {},
    ui: { custom, notify: vi.fn(), select: vi.fn(), setWidget: vi.fn() },
  } as unknown as ExtensionContext;

  const toolCall = handlers.get("tool_call") as unknown as (
    event: ToolCallEvent,
    ctx: ExtensionContext,
  ) => Promise<unknown>;
  const run = (context: ExtensionContext = ctx) =>
    toolCall(
      {
        type: "tool_call",
        toolCallId: "c1",
        toolName: "read",
        input: { path: "/outside/a.txt" },
      } as ToolCallEvent,
      context,
    );

  return { run, ctx, custom, appendEntry, decideSpy };
}

describe("path access delegation", () => {
  beforeEach(() => {
    state.mode = "ask";
  });

  it("lets delegates allow each outside path without a prompt", async () => {
    const { run, custom, decideSpy, appendEntry } = await setup(() => ({
      verdict: "allow",
      reason: "requested",
    }));

    await expect(run()).resolves.toBeUndefined();

    expect(custom).not.toHaveBeenCalled();
    expect(decideSpy).toHaveBeenCalledTimes(2);
    expect(decideSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        feature: "pathAccess",
        toolName: "read",
        action: expect.objectContaining({
          kind: "file",
          path: "/outside/a.txt",
        }),
      }),
      expect.anything(),
    );
    expect(appendEntry).toHaveBeenCalledTimes(2);
    expect(appendEntry).toHaveBeenCalledWith(
      DELEGATION_ENTRY_TYPE,
      expect.objectContaining({ feature: "pathAccess", verdict: "allow" }),
    );
  });

  it("blocks when a delegate blocks", async () => {
    const { run, custom } = await setup(() => ({
      verdict: "block",
      reason: "secrets",
    }));
    await expect(run()).resolves.toEqual({
      block: true,
      reason: "Blocked by decision delegate: test: secrets",
    });
    expect(custom).not.toHaveBeenCalled();
  });

  it("prompts when a delegate asks", async () => {
    const { run, custom } = await setup(() => ({
      verdict: "ask",
      reason: "unclear",
    }));
    await run();
    expect(custom).toHaveBeenCalledTimes(2);
  });

  it("asks delegates about every outside path at once", async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { run, custom, decideSpy } = await setup(async () => {
      await gate;
      return { verdict: "allow", reason: "requested" };
    });

    const pending = run();
    await vi.waitFor(() => expect(decideSpy).toHaveBeenCalledTimes(2));
    release();

    await expect(pending).resolves.toBeUndefined();
    expect(custom).not.toHaveBeenCalled();
  });

  it("skips the prompt for a path covered by a directory grant from an earlier prompt", async () => {
    const { run, custom } = await setup(() => ({
      verdict: "ask",
      reason: "unclear",
    }));
    custom.mockResolvedValueOnce("allow-dir-session");

    await expect(run()).resolves.toBeUndefined();
    expect(custom).toHaveBeenCalledTimes(1);
  });

  it("never consults delegates in block mode", async () => {
    state.mode = "block";
    const { run, decideSpy } = await setup(() => ({
      verdict: "allow",
      reason: "x",
    }));
    await expect(run()).resolves.toMatchObject({ block: true });
    expect(decideSpy).not.toHaveBeenCalled();
  });

  it("lets delegates decide outside a workspace without a UI", async () => {
    const { run, ctx, decideSpy } = await setup(() => ({
      verdict: "allow",
      reason: "requested",
    }));

    await expect(
      run({ ...ctx, hasUI: false } as ExtensionContext),
    ).resolves.toBeUndefined();
    expect(decideSpy).toHaveBeenCalledTimes(2);
  });

  it("blocks without a UI when a delegate asks, quoting its reasoning", async () => {
    const { run, ctx } = await setup(() => ({
      verdict: "ask",
      reason: "unclear whether your request covers this",
    }));

    const headless = { ...ctx, hasUI: false } as ExtensionContext;
    const outcome = await run(headless);
    const result = outcome as { block: boolean; reason: string };

    expect(result.block).toBe(true);
    expect(result.reason).toContain("Blocked (no UI to confirm)");
    expect(result.reason).toContain("/outside/a.txt");
    expect(result.reason).toContain("Model review");
    expect(result.reason).toContain(
      "test: unclear whether your request covers this",
    );
  });

  it("blocks without a UI when a delegate runs out of time", async () => {
    const { run, ctx } = await setup(async () => {
      await new Promise(() => undefined);
      return undefined;
    });

    const headless = { ...ctx, hasUI: false } as ExtensionContext;
    const outcome = await run(headless);
    const result = outcome as { block: boolean; reason: string };

    expect(result.block).toBe(true);
    expect(result.reason).toContain("Blocked (no UI to confirm)");
    expect(result.reason).toContain("test timed out");
  });

  it("keeps the plain no-UI block while delegates are still registering", async () => {
    const { run, ctx } = await setup(undefined);

    const headless = { ...ctx, hasUI: false } as ExtensionContext;
    const outcome = await run(headless);
    const result = outcome as { block: boolean; reason: string };

    expect(result.block).toBe(true);
    expect(result.reason).toContain("no UI to confirm");
    expect(result.reason).not.toContain("Model review");
  });
});
