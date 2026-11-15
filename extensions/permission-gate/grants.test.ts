import { beforeEach, describe, expect, it, vi } from "vitest";
import { configLoader } from "../../src/shared/config";
import {
  commandClassKey,
  describeCommandClass,
  isCommandAllowed,
  isCommandClassAllowed,
  saveCommandGrant,
} from "./grants";

vi.mock("../../src/shared/config", () => ({
  configLoader: {
    getConfig: vi.fn(),
    getRawConfig: vi.fn(),
    getScopePath: vi.fn(),
    save: vi.fn(),
  },
}));

const getConfig = vi.mocked(configLoader.getConfig);
const getRawConfig = vi.mocked(configLoader.getRawConfig);
const getScopePath = vi.mocked(configLoader.getScopePath);
const save = vi.mocked(configLoader.save);

function mockResolvedConfig(overrides: Record<string, unknown> = {}) {
  getConfig.mockReturnValue({
    permissionGate: { allowedPatterns: [], allowedClasses: [], ...overrides },
  } as unknown as ReturnType<typeof configLoader.getConfig>);
}

describe("command class keys", () => {
  it("names a built-in match by what the matcher called it", () => {
    const key = commandClassKey({
      description: "recursive force delete",
      pattern: "(structural)",
    });

    expect(key).toBe("builtin:recursive force delete");
    expect(describeCommandClass(key)).toBe("recursive force delete");
  });

  it("names a configured pattern by the pattern itself", () => {
    const key = commandClassKey({
      description: "terraform destroy",
      pattern: "terraform\\s+destroy",
    });

    expect(key).toBe("pattern:terraform\\s+destroy");
    expect(describeCommandClass(key)).toBe("terraform\\s+destroy");
  });

  it("names a text fallback match by the pattern it fell back to", () => {
    // A command that did not parse cleanly is flagged by the same configured
    // pattern, so one grant covers both spellings of it.
    const structural = commandClassKey({
      description: "recursive force delete",
      pattern: "rm -rf",
    });
    const configured = commandClassKey({
      description: "recursive force delete",
      pattern: "rm -rf",
    });

    expect(structural).toBe(configured);
    expect(describeCommandClass("builtin:recursive force delete")).toBe(
      "recursive force delete",
    );
  });
});

describe("command grants", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolvedConfig();
    getRawConfig.mockReturnValue(null);
    getScopePath.mockReturnValue(null);
    save.mockResolvedValue(undefined);
  });

  it("reads a granted class from the resolved config", () => {
    mockResolvedConfig({ allowedClasses: ["builtin:recursive force delete"] });

    expect(isCommandClassAllowed("builtin:recursive force delete")).toBe(true);
    expect(isCommandClassAllowed("builtin:superuser command")).toBe(false);
  });

  it("saves a grant to the chosen scope without dropping what the scope already held", async () => {
    getRawConfig.mockReturnValue({
      version: "0.22.0",
      pathAccess: { mode: "block" },
      permissionGate: {
        requireConfirmation: false,
        allowedClasses: ["builtin:superuser command"],
      },
    });

    const saved = await saveCommandGrant(
      "builtin:recursive force delete",
      "global",
    );

    expect(saved.scope).toBe("global");
    expect(saved.added).toBe(true);
    expect(save).toHaveBeenCalledWith("global", {
      version: "0.22.0",
      pathAccess: { mode: "block" },
      permissionGate: {
        requireConfirmation: false,
        allowedClasses: [
          "builtin:superuser command",
          "builtin:recursive force delete",
        ],
      },
    });
  });

  it("does not save a class that is already granted in that scope", async () => {
    getRawConfig.mockReturnValue({
      permissionGate: { allowedClasses: ["pattern:shred"] },
    });

    const saved = await saveCommandGrant("pattern:shred", "memory");

    expect(saved.added).toBe(false);
    expect(save).not.toHaveBeenCalled();
  });

  it("reports where a persisted grant lives", async () => {
    getScopePath.mockReturnValue("/project/.pi/extensions/guardrails.json");

    const saved = await saveCommandGrant("builtin:shred", "local");

    expect(saved.path).toBe("/project/.pi/extensions/guardrails.json");
  });

  it("keeps substring matching for configured allow patterns", () => {
    mockResolvedConfig({ allowedPatterns: [{ pattern: "git status" }] });

    expect(isCommandAllowed("cd /repo && git status")).toBe(true);
    expect(isCommandAllowed("git statusx")).toBe(true);
  });
});
