import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  BashToolCallEvent,
  ExtensionAPI,
  ExtensionContext,
  ExtensionHandler,
  ToolCallEvent,
  ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";
import { createMock, type PartialFuncReturn } from "@golevelup/ts-vitest";
import { vol } from "memfs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { configLoader } from "../../src/shared/config";
import permissionGate from "./index";

/**
 * The grant flow end to end, against the real config loader: what an answer to
 * the prompt covers is decided here, not in a unit test of the key format.
 */

const AGENT_DIR = "/tmp/pi-gate-grants";

type ToolCallHandler = ExtensionHandler<ToolCallEvent, ToolCallEventResult>;

function createCtx(
  overrides: Partial<PartialFuncReturn<ExtensionContext>> & {
    ui?: Partial<ExtensionContext["ui"]>;
  } = {},
) {
  const { ui: uiOverrides, ...rest } = overrides;
  return createMock<ExtensionContext>({
    hasUI: true,
    mode: "tui",
    cwd: process.cwd(),
    ui: {
      custom: vi.fn().mockResolvedValue(undefined),
      select: vi.fn().mockResolvedValue(undefined),
      notify: vi.fn(),
      ...uiOverrides,
    },
    abort: vi.fn(),
    ...rest,
  });
}

async function startSession(trusted: boolean) {
  vi.stubEnv("PI_CODING_AGENT_DIR", AGENT_DIR);
  vol.reset();
  vol.fromJSON({ [`${AGENT_DIR}/.keep`]: "" });

  const pi = createMock<ExtensionAPI>();
  await permissionGate(pi);
  await configLoader.loadProject({
    cwd: process.cwd(),
    isProjectTrusted: () => trusted,
  });

  const calls: unknown[][] = pi.on.mock.calls;
  const handler = calls.find(([event]) => event === "tool_call")?.[1] as
    | ToolCallHandler
    | undefined;
  if (!handler) throw new Error("tool_call handler was not registered");

  const bash = (command: string, ctx = createCtx()) =>
    handler(
      {
        type: "tool_call",
        toolCallId: `call-${command}`,
        toolName: "bash",
        input: { command },
      } satisfies BashToolCallEvent,
      ctx,
    );

  return { pi, handler, bash };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vol.reset();
});

describe("permission gate grants", () => {
  it("covers the next command the same rule flags, not just the one on screen", async () => {
    const { bash } = await startSession(true);

    const prompted = createCtx({
      ui: { custom: vi.fn().mockResolvedValue("allow-session") },
    });
    // A recursive delete outside the scratch root: flagged, and answered once.
    const answered = await bash("rm -rf /home/mike/build-1", prompted);
    expect(answered).toBeUndefined();
    expect(prompted.ui.custom).toHaveBeenCalledTimes(1);

    // The next cleanup the same rule flags is a different command string.
    const next = createCtx();
    const cleaned = await bash("rm -rf ./scratch", next);
    expect(cleaned).toBeUndefined();
    expect(next.ui.custom).not.toHaveBeenCalled();

    // A different class of risk still asks.
    const other = createCtx({
      ui: { custom: vi.fn().mockResolvedValue("deny") },
    });
    const privileged = await bash("sudo apt update", other);
    expect(privileged).toEqual({
      block: true,
      reason: "User denied dangerous command",
    });
    expect(other.ui.custom).toHaveBeenCalledTimes(1);
  });

  it("writes an always grant to the project config as a class entry", async () => {
    const { bash } = await startSession(true);

    const ctx = createCtx({
      ui: { custom: vi.fn().mockResolvedValue("allow-always") },
    });
    const answered = await bash("rm -rf /home/mike/build-1", ctx);
    expect(answered).toBeUndefined();

    const configPath = join(process.cwd(), ".pi/extensions/guardrails.json");
    const contents = await readFile(configPath, "utf-8");
    const saved = JSON.parse(contents);
    expect(saved.permissionGate.allowedClasses).toEqual([
      "builtin:recursive force delete",
    ]);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining(".pi/extensions/guardrails.json"),
      "info",
    );

    // A reload keeps it: this is what separates an always grant from a session
    // grant, which lives in the ephemeral memory scope.
    await configLoader.load();
    await configLoader.loadProject({
      cwd: process.cwd(),
      isProjectTrusted: () => true,
    });
    const afterReload = createCtx();
    const next = await bash("rm -rf /home/mike/build-2", afterReload);
    expect(next).toBeUndefined();
    expect(afterReload.ui.custom).not.toHaveBeenCalled();
  });

  it("does not offer an always grant the session cannot read back", async () => {
    const { bash } = await startSession(false);

    const select = vi.fn().mockResolvedValue("Deny");
    const ctx = createCtx({
      ui: { custom: vi.fn().mockResolvedValue(undefined), select },
    });
    await bash("rm -rf /home/mike/build-1", ctx);

    const [, options] = select.mock.calls[0] ?? [];
    expect(options).toContain('Allow "recursive force delete" this session');
    expect(options).not.toContain('Always allow "recursive force delete"');
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("not trusted"),
      "warning",
    );
  });

  it("keeps auto-deny patterns above a class grant", async () => {
    const { bash } = await startSession(true);

    await configLoader.save("memory", {
      permissionGate: {
        allowedClasses: ["builtin:superuser command"],
        autoDenyPatterns: [
          { pattern: "sudo", description: "no privilege escalation" },
        ],
      },
    });

    const ctx = createCtx();
    const blocked = await bash("sudo rm -rf /home/mike/build-1", ctx);
    expect(blocked).toEqual({
      block: true,
      reason: "Command auto-denied: no privilege escalation",
    });
    expect(ctx.ui.custom).not.toHaveBeenCalled();
  });
});
