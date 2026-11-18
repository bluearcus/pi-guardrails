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
import { answerFor, pressKeys } from "../../tests/utils/prompt-answers";
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
    ui?: Omit<Partial<ExtensionContext["ui"]>, "custom"> & {
      custom?: unknown;
    };
  } = {},
) {
  const { ui: uiOverrides, ...rest } = overrides;
  const { custom: customOverride, ...uiRest } = uiOverrides ?? {};
  return createMock<ExtensionContext>({
    hasUI: true,
    mode: "tui",
    cwd: process.cwd(),
    ui: {
      custom: answerFor(customOverride) ?? vi.fn().mockResolvedValue(undefined),
      select: vi.fn().mockResolvedValue(undefined),
      notify: vi.fn(),
      ...uiRest,
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

    // The grant is for that directory, so the same directory spelled differently
    // — relative, deeper — is quiet.
    for (const command of [
      "rm -rf build-1",
      "rm -rf /home/mike/project/build-1/cache",
      "rm -rf ./build-1/old",
    ]) {
      const next = createCtx({ cwd: PROJECT });
      const cleaned = await bash(command, next);
      expect(cleaned, command).toBeUndefined();
      expect(next.ui.custom, command).not.toHaveBeenCalled();
    }

    // A neighbouring build directory was never part of the answer, so it asks.
    for (const command of [
      "rm -rf build-2",
      "rm -rf /home/mike/project/build-2",
    ]) {
      const neighbour = createCtx({
        cwd: PROJECT,
        ui: { custom: vi.fn().mockResolvedValue("deny") },
      });
      const flagged = await bash(command, neighbour);
      expect(flagged, command).toEqual({
        block: true,
        reason: "User denied dangerous command",
      });
      expect(neighbour.ui.custom, command).toHaveBeenCalledTimes(1);
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

  it("grants the directory a compound command works in, not the one the call started in", async () => {
    const build = `${PROJECT}/build`;
    const { bash } = await startSession(true);

    const prompted = createCtx({
      cwd: PROJECT,
      ui: { custom: vi.fn().mockResolvedValue("allow-session") },
    });
    const answered = await bash("cd build && make && rm -rf $BDIR", prompted);
    expect(answered).toBeUndefined();
    expect(prompted.ui.custom).toHaveBeenCalledTimes(1);

    // The same shape of cleanup in the same directory, spelled differently.
    for (const command of [
      "cd build && make clean && rm -rf out",
      "cd build && cd debug && rm -rf $BDIR",
      `cd ${build} && rm -rf .layout`,
    ]) {
      const next = createCtx({ cwd: PROJECT });
      const cleaned = await bash(command, next);
      expect(cleaned, command).toBeUndefined();
      expect(next.ui.custom, command).not.toHaveBeenCalled();
    }

    // The grant is over the directory the command worked in, so the one next to
    // it still asks.
    const neighbour = createCtx({
      cwd: PROJECT,
      ui: { custom: vi.fn().mockResolvedValue("deny") },
    });
    const other = await bash("cd other && rm -rf build", neighbour);
    expect(other).toEqual({
      block: true,
      reason: "User denied dangerous command",
    });
    expect(neighbour.ui.custom).toHaveBeenCalledTimes(1);
  });

  it("offers the compound command's own directory at the prompt", async () => {
    const { bash } = await startSession(true);
    const select = vi.fn().mockResolvedValue("Deny");
    const ctx = createCtx({
      cwd: PROJECT,
      ui: { custom: vi.fn().mockResolvedValue(undefined), select },
    });

    const blocked = await bash("cd build && make && rm -rf $BDIR", ctx);
    expect(blocked).toEqual({
      block: true,
      reason: "User denied dangerous command",
    });

    const [, options] = select.mock.calls[0] ?? [];
    expect(options).toEqual([
      "Allow once",
      "Allow recursive force delete of ~/project/build this session",
      "Always allow recursive force delete of ~/project/build",
      "Deny",
      "Decline and stop",
    ]);
  });

  it("asks for each directory a delete impacts and saves one grant per directory", async () => {
    const { bash } = await startSession(true);

    const select = vi
      .fn()
      .mockResolvedValue(
        "Allow recursive force delete of ~/project/build, ~/project/out this session",
      );
    const ctx = createCtx({
      cwd: PROJECT,
      ui: { custom: vi.fn().mockResolvedValue(undefined), select },
    });
    const answered = await bash("rm -rf build out", ctx);
    expect(answered).toBeUndefined();

    const [, options] = select.mock.calls[0] ?? [];
    expect(options).toEqual([
      "Allow once",
      "Allow recursive force delete of ~/project/build, ~/project/out this session",
      "Always allow recursive force delete of ~/project/build, ~/project/out",
      "Choose per directory (grant some, refuse others)",
      "Deny",
      "Decline and stop",
    ]);

    // A select has no room for the note, so the directories ride in its message.
    const [message] = select.mock.calls[0] ?? [];
    expect(message).toContain("~/project/build");
    expect(message).toContain("~/project/out");

    // Both directories are covered, by two entries a user can revoke separately.
    for (const command of ["rm -rf build", "rm -rf out", "rm -rf build/old"]) {
      const next = createCtx({ cwd: PROJECT });
      const cleaned = await bash(command, next);
      expect(cleaned, command).toBeUndefined();
      expect(next.ui.custom, command).not.toHaveBeenCalled();
    }

    // A third directory in the same project was not part of the answer.
    const third = createCtx({
      cwd: PROJECT,
      ui: { custom: vi.fn().mockResolvedValue("deny") },
    });
    const flagged = await bash("rm -rf tests", third);
    expect(flagged).toEqual({
      block: true,
      reason: "User denied dangerous command",
    });
  });

  it("answers each directory in turn when there is no custom component", async () => {
    const { bash } = await startSession(true);

    const select = vi
      .fn()
      .mockResolvedValueOnce("Choose per directory (grant some, refuse others)")
      .mockResolvedValueOnce("Grant it for this session")
      .mockResolvedValueOnce("Allow this command once, no grant");
    const ctx = createCtx({
      cwd: PROJECT,
      ui: { custom: vi.fn().mockResolvedValue(undefined), select },
    });
    const answered = await bash("rm -rf build out", ctx);
    expect(answered).toBeUndefined();

    // One question per directory, in the order the prompt listed them.
    const [firstQuestion] = select.mock.calls[1] ?? [];
    expect(firstQuestion).toBe("recursive force delete of ~/project/build");
    const [secondQuestion] = select.mock.calls[2] ?? [];
    expect(secondQuestion).toBe("recursive force delete of ~/project/out");

    const granted = createCtx({ cwd: PROJECT });
    const quiet = await bash("rm -rf build", granted);
    expect(quiet).toBeUndefined();
    expect(granted.ui.custom).not.toHaveBeenCalled();

    const ungranted = createCtx({ cwd: PROJECT, ui: { custom: "deny" } });
    const blocked = await bash("rm -rf out", ungranted);
    expect(blocked).toEqual({
      block: true,
      reason: "User denied dangerous command",
    });
  });

  it("grants one directory and allows another once, in one answer", async () => {
    const { bash } = await startSession(true);

    // c opens the per-directory answers: a session grant for build-1, and no
    // standing grant for out-1 even though this command is allowed.
    const prompted = createCtx({
      cwd: PROJECT,
      ui: { custom: pressKeys(["c", "a", "y", "\r"]) },
    });
    const answered = await bash("rm -rf build-1 out-1", prompted);
    expect(answered).toBeUndefined();

    const granted = createCtx({ cwd: PROJECT });
    const quiet = await bash("rm -rf build-1", granted);
    expect(quiet).toBeUndefined();
    expect(granted.ui.custom).not.toHaveBeenCalled();

    const ungranted = createCtx({ cwd: PROJECT, ui: { custom: "deny" } });
    const blocked = await bash("rm -rf out-1", ungranted);
    expect(blocked).toEqual({
      block: true,
      reason: "User denied dangerous command",
    });
  });

  it("refuses one directory without wasting the grant given to another", async () => {
    const { bash } = await startSession(true);

    const prompted = createCtx({
      cwd: PROJECT,
      ui: { custom: pressKeys(["c", "a", "n", "\r"]) },
    });
    // One command deletes both, so refusing out-1 blocks the command. The grant
    // for build-1 is still the user's answer for that directory.
    const blocked = await bash("rm -rf build-1 out-1", prompted);
    expect(blocked).toEqual({
      block: true,
      reason: "User denied dangerous command",
    });

    const granted = createCtx({ cwd: PROJECT });
    const quiet = await bash("rm -rf build-1", granted);
    expect(quiet).toBeUndefined();
    expect(granted.ui.custom).not.toHaveBeenCalled();

    const held = configLoader
      .getConfig()
      .permissionGate.grants.map((grant) => grant.directory);
    expect(held).toEqual([`${PROJECT}/build-1`]);
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
      {
        class: "builtin:recursive force delete",
        directory: `${PROJECT}/build-1`,
      },
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
    const next = await bash("rm -rf build-1/old", afterReload);
    expect(next).toBeUndefined();
    expect(afterReload.ui.custom).not.toHaveBeenCalled();

    // And it is still only that directory.
    const neighbour = createCtx({
      cwd: PROJECT,
      ui: { custom: vi.fn().mockResolvedValue("deny") },
    });
    const flagged = await bash("rm -rf build-2", neighbour);
    expect(flagged).toEqual({
      block: true,
      reason: "User denied dangerous command",
    });
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
      "Allow recursive force delete of ~/project/build-1 this session",
    );
    expect(options).not.toContain(
      "Always allow recursive force delete of ~/project/build-1",
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
