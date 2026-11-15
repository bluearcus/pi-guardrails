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
const PROJECT = "/home/mike/project";

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

function startSession(
  trusted: boolean,
  cwd: string = PROJECT,
  files: Record<string, string> = {},
) {
  return startSessionWithFiles(trusted, cwd, files);
}

async function startSessionWithFiles(
  trusted: boolean,
  cwd: string,
  files: Record<string, string>,
) {
  vi.stubEnv("PI_CODING_AGENT_DIR", AGENT_DIR);
  vol.reset();
  vol.fromJSON({ [`${AGENT_DIR}/.keep`]: "", ...files });

  const pi = createMock<ExtensionAPI>();
  await permissionGate(pi);
  await configLoader.load();
  await configLoader.loadProject({
    cwd,
    isProjectTrusted: () => trusted,
  });

  const calls: unknown[][] = pi.on.mock.calls;
  const handler = calls.find(([event]) => event === "tool_call")?.[1] as
    | ToolCallHandler
    | undefined;
  if (!handler) throw new Error("tool_call handler was not registered");

  const bash = (command: string, ctx = createCtx({ cwd })) =>
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
  it("covers the next command of the class in the granted directory", async () => {
    const { bash } = await startSession(true);

    const prompted = createCtx({
      cwd: PROJECT,
      ui: { custom: vi.fn().mockResolvedValue("allow-session") },
    });
    // A recursive delete outside any scratch root: flagged, and answered once.
    const answered = await bash("rm -rf /home/mike/project/build-1", prompted);
    expect(answered).toBeUndefined();
    expect(prompted.ui.custom).toHaveBeenCalledTimes(1);

    // The next cleanup of the same class in the same directory is a different
    // command string, and a relative one.
    for (const command of [
      "rm -rf /home/mike/project/build-2",
      "rm -rf .layout",
      "rm -rf $BDIR",
    ]) {
      const next = createCtx({ cwd: PROJECT });
      const cleaned = await bash(command, next);
      expect(cleaned, command).toBeUndefined();
      expect(next.ui.custom, command).not.toHaveBeenCalled();
    }

    // A different class of risk still asks.
    const other = createCtx({
      cwd: PROJECT,
      ui: { custom: vi.fn().mockResolvedValue("deny") },
    });
    const privileged = await bash("sudo apt update", other);
    expect(privileged).toEqual({
      block: true,
      reason: "User denied dangerous command",
    });
    expect(other.ui.custom).toHaveBeenCalledTimes(1);
  });

  it("does not carry the same grant to another directory", async () => {
    const { bash } = await startSession(true);

    const prompted = createCtx({
      cwd: PROJECT,
      ui: { custom: vi.fn().mockResolvedValue("allow-session") },
    });
    await bash("rm -rf /home/mike/project/build-1", prompted);

    // The session is working somewhere else now: the grant says nothing about it.
    const elsewhere = createCtx({
      cwd: "/home/mike/elsewhere",
      ui: { custom: vi.fn().mockResolvedValue("deny") },
    });
    const flagged = await bash("rm -rf ./build", elsewhere);
    expect(flagged).toEqual({
      block: true,
      reason: "User denied dangerous command",
    });
    expect(elsewhere.ui.custom).toHaveBeenCalledTimes(1);

    // Nor does a delete of the granted directory itself pass on the grant.
    const whole = createCtx({
      cwd: "/home/mike",
      ui: { custom: vi.fn().mockResolvedValue("deny") },
    });
    const deleted = await bash("rm -rf /home/mike/project", whole);
    expect(deleted).toEqual({
      block: true,
      reason: "User denied dangerous command",
    });
  });

  it("writes an always grant to the project config as a class and directory", async () => {
    const { bash } = await startSession(true);

    const ctx = createCtx({
      cwd: PROJECT,
      ui: { custom: vi.fn().mockResolvedValue("allow-always") },
    });
    const answered = await bash("rm -rf /home/mike/project/build-1", ctx);
    expect(answered).toBeUndefined();

    const configPath = join(PROJECT, ".pi/extensions/guardrails.json");
    const contents = await readFile(configPath, "utf-8");
    const saved = JSON.parse(contents);
    expect(saved.permissionGate.grants).toEqual([
      { class: "builtin:recursive force delete", directory: PROJECT },
    ]);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining(".pi/extensions/guardrails.json"),
      "info",
    );

    // A reload keeps it: this is what separates an always grant from a session
    // grant, which lives in the ephemeral memory scope.
    await configLoader.load();
    await configLoader.loadProject({
      cwd: PROJECT,
      isProjectTrusted: () => true,
    });
    const afterReload = createCtx({ cwd: PROJECT });
    const next = await bash("rm -rf /home/mike/project/build-2", afterReload);
    expect(next).toBeUndefined();
    expect(afterReload.ui.custom).not.toHaveBeenCalled();
  });

  it("offers no grant when the action spans directories", async () => {
    const { bash } = await startSession(true);

    const select = vi.fn().mockResolvedValue("Deny");
    const ctx = createCtx({
      cwd: PROJECT,
      ui: { custom: vi.fn().mockResolvedValue(undefined), select },
    });
    await bash("rm -rf /home/mike/project/build /home/mike/Sync/out", ctx);

    const [, options] = select.mock.calls[0] ?? [];
    expect(options).toEqual(["Allow once", "Deny", "Decline and stop"]);
  });

  it("does not offer an always grant the session cannot read back", async () => {
    const { bash } = await startSession(false);

    const select = vi.fn().mockResolvedValue("Deny");
    const ctx = createCtx({
      cwd: PROJECT,
      ui: { custom: vi.fn().mockResolvedValue(undefined), select },
    });
    await bash("rm -rf /home/mike/project/build-1", ctx);

    const [, options] = select.mock.calls[0] ?? [];
    expect(options).toContain(
      "Allow recursive force delete under ~/project this session",
    );
    expect(options).not.toContain(
      "Always allow recursive force delete under ~/project",
    );
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("not trusted"),
      "warning",
    );
  });

  it("keeps auto-deny patterns above a directory grant", async () => {
    const { bash } = await startSession(true);

    await configLoader.save("memory", {
      permissionGate: {
        grants: [{ class: "builtin:superuser command", directory: PROJECT }],
        autoDenyPatterns: [
          { pattern: "sudo", description: "no privilege escalation" },
        ],
      },
    });

    const ctx = createCtx({ cwd: PROJECT });
    const blocked = await bash("sudo rm -rf /home/mike/project/build-1", ctx);
    expect(blocked).toEqual({
      block: true,
      reason: "Command auto-denied: no privilege escalation",
    });
    expect(ctx.ui.custom).not.toHaveBeenCalled();
  });

  it("reads a grant written to the project config", async () => {
    const { bash } = await startSession(true, "/srv/build", {
      "/srv/build/.pi/extensions/guardrails.json": JSON.stringify({
        version: "0.16.2",
        permissionGate: {
          grants: [
            {
              class: "builtin:recursive force delete",
              directory: "/srv/build",
            },
          ],
        },
      }),
    });

    const ctx = createCtx({ cwd: "/srv/build" });
    const cleaned = await bash("rm -rf ./out", ctx);
    expect(cleaned).toBeUndefined();
    expect(ctx.ui.custom).not.toHaveBeenCalled();
  });
});
