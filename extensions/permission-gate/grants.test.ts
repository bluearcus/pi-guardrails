import { vol } from "memfs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandGrant } from "../../src/core/commands";
import {
  commandGrantCovers,
  literalTargetDirectory,
} from "../../src/core/commands";
import { configLoader } from "../../src/shared/config";
import {
  describeCommandClass,
  describeGrant,
  describeGrantDirectory,
  findGrantScope,
  grantCandidateFor,
  isCommandAllowed,
  isGrantTooBroad,
  removeCommandGrant,
  saveCommandGrant,
} from "./grants";

/** The resolved config the grant helpers read, replaced per test. */
let resolvedConfig: Record<string, unknown> = {
  permissionGate: { allowedPatterns: [], grants: [] },
};

vi.mock("../../src/shared/config", () => {
  return {
    configLoader: {
      getConfig: vi.fn(() => resolvedConfig),
      getRawConfig: vi.fn(() => null),
      getScopePath: vi.fn(() => null),
      save: vi.fn(async () => undefined),
    },
  };
});

const DELETE_CLASS = "builtin:recursive force delete";

function mockResolvedConfig(overrides: Record<string, unknown> = {}) {
  resolvedConfig = {
    ...resolvedConfig,
    permissionGate: {
      allowedPatterns: [],
      grants: [],
      ...overrides,
    },
  };
}

describe("grantCandidateFor", () => {
  beforeEach(() => {
    vol.reset();
  });

  it("names the class and the directory the action happens in", () => {
    expect(
      grantCandidateFor(DELETE_CLASS, "rm -rf build", "/home/mike/project"),
    ).toEqual({
      class: DELETE_CLASS,
      directory: "/home/mike/project",
    });
    expect(
      grantCandidateFor(DELETE_CLASS, "rm -rf .layout", "/home/mike/pro"),
    ).toEqual({ class: DELETE_CLASS, directory: "/home/mike/pro" });
  });

  it("names a scratch root for a delete inside it", () => {
    expect(
      grantCandidateFor(DELETE_CLASS, "rm -rf /tmp/build", "/home/mike/pro", [
        "/tmp",
      ]),
    ).toEqual({ class: DELETE_CLASS, directory: "/tmp" });
    expect(
      grantCandidateFor(DELETE_CLASS, "rm -rf out", "/home/mike/pro", ["."]),
    ).toEqual({ class: DELETE_CLASS, directory: "/home/mike/pro" });
  });

  it("offers no grant over the tree around the working directory", () => {
    // Deleting the parent would need a grant over everything next to it.
    expect(
      grantCandidateFor(DELETE_CLASS, "rm -rf ..", "/home/mike/project/build"),
    ).toBeUndefined();
    expect(
      grantCandidateFor(
        DELETE_CLASS,
        "rm -rf /home/mike/project/sub/build",
        "/home/mike/project/build",
      ),
    ).toBeUndefined();
  });

  it("names the directory a compound command works in", () => {
    // The flagged delete is inside the command; the `cd` in front of it says
    // where it happens, so that is the directory the grant has to name.
    expect(
      grantCandidateFor(
        DELETE_CLASS,
        "cd /work/follow9/build && make && rm -rf $BDIR",
        "/workspace",
      ),
    ).toEqual({ class: DELETE_CLASS, directory: "/work/follow9/build" });
    expect(
      grantCandidateFor(
        DELETE_CLASS,
        "cd /work/follow9/build && make clean && rm -rf out/deep",
        "/workspace",
      ),
    ).toEqual({ class: DELETE_CLASS, directory: "/work/follow9/build/out" });
    expect(
      grantCandidateFor(
        DELETE_CLASS,
        "cd /work/follow9 && make && rm -rf build",
        "/workspace",
      ),
    ).toEqual({ class: DELETE_CLASS, directory: "/work/follow9" });
    expect(
      grantCandidateFor(
        DELETE_CLASS,
        "cd build && rm -rf out",
        "/home/mike/project",
      ),
    ).toEqual({ class: DELETE_CLASS, directory: "/home/mike/project/build" });
  });

  it("offers nothing when the compound command does not say where it works", () => {
    for (const command of [
      "cd $WORK && rm -rf build",
      "cd $(mktemp -d) && rm -rf scratch",
      "cd /work/build && rm -rf ..",
    ]) {
      expect(
        grantCandidateFor(DELETE_CLASS, command, "/home/mike/project"),
      ).toBeUndefined();
    }
  });

  it("covers a wildcard only where its literal part sits", () => {
    const grant = { class: DELETE_CLASS, directory: "/home/mike/project" };
    expect(
      commandGrantCovers(grant, DELETE_CLASS, ["/tmp/*"], "/home/mike/project"),
    ).toBe(false);
    expect(
      commandGrantCovers(
        grant,
        DELETE_CLASS,
        ["/home/mike/project/build/*"],
        "/home/mike/project",
      ),
    ).toBe(true);
    expect(literalTargetDirectory("/tmp/*", "/home/mike/pro")).toBe("/tmp");
    expect(
      literalTargetDirectory("$BDIR/build", "/home/mike/pro"),
    ).toBeUndefined();
  });

  it("names the working directory for a target it cannot place", () => {
    expect(
      grantCandidateFor(DELETE_CLASS, "rm -rf $BDIR", "/home/mike/pro"),
    ).toEqual({ class: DELETE_CLASS, directory: "/home/mike/pro" });
    expect(
      grantCandidateFor("pattern:mkfs.", "mkfs.ext4 $DEV", "/mnt/usb"),
    ).toEqual({ class: "pattern:mkfs.", directory: "/mnt/usb" });
  });

  it("offers nothing when the action spans directories", () => {
    expect(
      grantCandidateFor(
        DELETE_CLASS,
        "rm -rf /home/mike/Sync/build /tmp/build",
        "/home/mike",
      ),
    ).toBeUndefined();
    expect(
      grantCandidateFor(DELETE_CLASS, "rm -rf $BDIR", undefined),
    ).toBeUndefined();
  });

  it("offers nothing whose directory is the home directory itself", () => {
    vi.stubEnv("HOME", "/home/mike");
    expect(
      grantCandidateFor(DELETE_CLASS, "rm -rf /home/mike/build", "/tmp"),
    ).toBeUndefined();
    vi.unstubAllEnvs();
  });
});

describe("describeGrant", () => {
  it("spells a grant as class under directory", () => {
    expect(describeGrant({ class: DELETE_CLASS, directory: "/tmp/work" })).toBe(
      "recursive force delete under /tmp/work",
    );
    expect(
      describeGrant({
        class: "pattern:docker run --privileged",
        directory: "/srv",
      }),
    ).toBe("docker run --privileged under /srv");
  });

  it("collapses the home directory to ~", () => {
    vi.stubEnv("HOME", "/home/mike");
    expect(describeGrantDirectory("/home/mike/Sync/Projects/build")).toBe(
      "~/Sync/Projects/build",
    );
    expect(describeGrantDirectory("/home/mike")).toBe("~");
    expect(describeGrantDirectory("/tmp")).toBe("/tmp");
    vi.unstubAllEnvs();
  });

  it("labels a class without its prefix", () => {
    expect(describeCommandClass(DELETE_CLASS)).toBe("recursive force delete");
    expect(describeCommandClass("pattern:shred")).toBe("shred");
  });
});

describe("isGrantTooBroad", () => {
  it("refuses the filesystem root and the home directory", () => {
    vi.stubEnv("HOME", "/home/mike");
    expect(isGrantTooBroad("/")).toBe(true);
    expect(isGrantTooBroad("/home/mike")).toBe(true);
    expect(isGrantTooBroad("/home/mike/Sync")).toBe(false);
    expect(isGrantTooBroad("/tmp")).toBe(false);
    vi.unstubAllEnvs();
  });
});

describe("saveCommandGrant", () => {
  const grant: CommandGrant = {
    class: DELETE_CLASS,
    directory: "/home/mike/project",
  };

  beforeEach(() => {
    vi.mocked(configLoader.getRawConfig).mockReturnValue(null);
    vi.mocked(configLoader.save).mockClear();
    vi.mocked(configLoader.getScopePath).mockReturnValue("/tmp/scope.json");
  });

  it("adds the grant to the scope's own config", async () => {
    vi.mocked(configLoader.getRawConfig).mockReturnValue({
      version: "0.16.2",
      pathAccess: { mode: "ask" },
      permissionGate: { requireConfirmation: true },
    });

    const saved = await saveCommandGrant(grant, "local");
    expect(saved).toEqual({
      scope: "local",
      path: "/tmp/scope.json",
      added: true,
    });

    const saved_ = vi.mocked(configLoader.save).mock.calls[0]?.[1] as {
      version: string;
      pathAccess: { mode: string };
      permissionGate: { requireConfirmation: boolean; grants: CommandGrant[] };
    };
    expect(saved_.version).toBe("0.16.2");
    expect(saved_.pathAccess.mode).toBe("ask");
    expect(saved_.permissionGate.requireConfirmation).toBe(true);
    expect(saved_.permissionGate.grants).toEqual([grant]);
  });

  it("keeps grants already in the scope", async () => {
    vi.mocked(configLoader.getRawConfig).mockReturnValue({
      permissionGate: {
        grants: [{ class: "pattern:shred", directory: "/data" }],
      },
    });

    await saveCommandGrant(grant, "memory");
    const written = vi.mocked(configLoader.save).mock.calls[0]?.[1] as {
      permissionGate: { grants: CommandGrant[] };
    };
    expect(written.permissionGate.grants).toEqual([
      { class: "pattern:shred", directory: "/data" },
      grant,
    ]);
  });

  it("does not save the same grant twice", async () => {
    vi.mocked(configLoader.getRawConfig).mockReturnValue({
      permissionGate: { grants: [grant] },
    });

    const saved = await saveCommandGrant(grant, "global");
    expect(saved.added).toBe(false);
    expect(vi.mocked(configLoader.save)).not.toHaveBeenCalled();
  });
});

describe("removeCommandGrant", () => {
  const grant: CommandGrant = {
    class: DELETE_CLASS,
    directory: "/home/mike/project",
  };

  beforeEach(() => {
    vi.mocked(configLoader.getRawConfig).mockReturnValue(null);
    vi.mocked(configLoader.save).mockClear();
  });

  it("writes the scope without that grant, keeping the rest", async () => {
    vi.mocked(configLoader.getRawConfig).mockReturnValue({
      version: "0.16.2",
      permissionGate: {
        autoDenyPatterns: [{ pattern: "dd of=" }],
        grants: [grant, { class: "pattern:shred", directory: "/data" }],
      },
    });

    const removed = await removeCommandGrant(grant, "global");
    expect(removed).toBe(true);
    const written = vi.mocked(configLoader.save).mock.calls[0]?.[1] as {
      version: string;
      permissionGate: {
        autoDenyPatterns: { pattern: string }[];
        grants: CommandGrant[];
      };
    };
    expect(written.version).toBe("0.16.2");
    expect(written.permissionGate.autoDenyPatterns).toEqual([
      { pattern: "dd of=" },
    ]);
    expect(written.permissionGate.grants).toEqual([
      { class: "pattern:shred", directory: "/data" },
    ]);
  });

  it("saves nothing when the grant is not in the scope", async () => {
    vi.mocked(configLoader.getRawConfig).mockReturnValue({
      permissionGate: {
        grants: [{ class: "pattern:shred", directory: "/data" }],
      },
    });

    const removed = await removeCommandGrant(grant, "global");
    expect(removed).toBe(false);
    expect(vi.mocked(configLoader.save)).not.toHaveBeenCalled();
  });
});

describe("findGrantScope", () => {
  const grant: CommandGrant = {
    class: DELETE_CLASS,
    directory: "/home/mike/project",
  };

  beforeEach(() => {
    vi.mocked(configLoader.getRawConfig).mockReset();
    vi.mocked(configLoader.getScopePath).mockReturnValue("/tmp/scope.json");
  });

  it("reports the scope that holds the grant", () => {
    vi.mocked(configLoader.getRawConfig).mockImplementation((scope) =>
      scope === "global" ? { permissionGate: { grants: [grant] } } : null,
    );

    expect(findGrantScope(grant)).toEqual({
      scope: "global",
      path: "/tmp/scope.json",
      added: false,
    });
  });

  it("matches a directory written differently", () => {
    vi.mocked(configLoader.getRawConfig).mockImplementation((scope) =>
      scope === "local"
        ? {
            permissionGate: {
              grants: [
                { class: DELETE_CLASS, directory: "/home/mike/project/" },
              ],
            },
          }
        : null,
    );

    expect(findGrantScope(grant).scope).toBe("local");
  });

  it("reports memory when no config file holds it", () => {
    vi.mocked(configLoader.getRawConfig).mockReturnValue(null);
    expect(findGrantScope(grant)).toEqual({
      scope: "memory",
      path: null,
      added: false,
    });
  });
});

describe("isCommandAllowed", () => {
  it("keeps matching configured allow patterns as substrings", () => {
    mockResolvedConfig({
      allowedPatterns: [{ pattern: "git status", regex: false }],
    });

    expect(isCommandAllowed("cd /repo && git status")).toBe(true);
    expect(isCommandAllowed("cd /repo && git statusx")).toBe(true);
    expect(isCommandAllowed("cd /repo && git push")).toBe(false);
  });
});
