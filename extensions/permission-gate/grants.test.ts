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
  describeGrantOffer,
  describeGrants,
  findGrantScope,
  grantCandidatesFor,
  isCommandAllowed,
  isGrantTooBroad,
  removeCommandGrant,
  saveCommandGrants,
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

describe("grantCandidatesFor", () => {
  beforeEach(() => {
    vol.reset();
  });

  it("names the class and the directory the delete impacts", () => {
    expect(
      grantCandidatesFor(DELETE_CLASS, "rm -rf build", "/home/mike/project"),
    ).toEqual([{ class: DELETE_CLASS, directory: "/home/mike/project/build" }]);
    expect(
      grantCandidatesFor(DELETE_CLASS, "rm -rf .layout", "/home/mike/pro"),
    ).toEqual([{ class: DELETE_CLASS, directory: "/home/mike/pro/.layout" }]);
  });

  it("names every directory the delete impacts, one grant each", () => {
    expect(
      grantCandidatesFor(
        DELETE_CLASS,
        "rm -rf build out tests",
        "/home/mike/project",
      ),
    ).toEqual([
      { class: DELETE_CLASS, directory: "/home/mike/project/build" },
      { class: DELETE_CLASS, directory: "/home/mike/project/out" },
      { class: DELETE_CLASS, directory: "/home/mike/project/tests" },
    ]);
  });

  it("names the directory a delete inside a scratch root hits", () => {
    expect(
      grantCandidatesFor(DELETE_CLASS, "rm -rf /tmp/build", "/home/mike/pro", [
        "/tmp",
      ]),
    ).toEqual([{ class: DELETE_CLASS, directory: "/tmp/build" }]);
    expect(
      grantCandidatesFor(DELETE_CLASS, "rm -rf out", "/home/mike/pro", ["."]),
    ).toEqual([{ class: DELETE_CLASS, directory: "/home/mike/pro/out" }]);
  });

  it("offers no grant over the tree around the working directory", () => {
    // Deleting the parent would need a grant over everything next to it.
    expect(
      grantCandidatesFor(DELETE_CLASS, "rm -rf ..", "/home/mike/project/build"),
    ).toEqual([]);
    expect(
      grantCandidatesFor(
        DELETE_CLASS,
        "rm -rf /home/mike/project/sub/build",
        "/home/mike/project/build",
      ),
    ).toEqual([]);
  });

  it("offers no grant over the directory the call started in", () => {
    // That grant is authority over the whole project, which is never what the
    // prompt is asking for.
    for (const command of [
      "rm -rf .",
      "rm -rf /home/mike/project",
      "rm -rf $BDIR",
    ]) {
      expect(
        grantCandidatesFor(DELETE_CLASS, command, "/home/mike/project"),
        command,
      ).toEqual([]);
    }
  });

  it("names the directory a compound command works in", () => {
    // The flagged delete is inside the command; the `cd` in front of it says
    // where it happens, so that is where its target sits.
    expect(
      grantCandidatesFor(
        DELETE_CLASS,
        "cd /work/follow9/build && make && rm -rf $BDIR",
        "/workspace",
      ),
    ).toEqual([{ class: DELETE_CLASS, directory: "/work/follow9/build" }]);
    expect(
      grantCandidatesFor(
        DELETE_CLASS,
        "cd /work/follow9/build && make clean && rm -rf out/deep",
        "/workspace",
      ),
    ).toEqual([
      { class: DELETE_CLASS, directory: "/work/follow9/build/out/deep" },
    ]);
    expect(
      grantCandidatesFor(
        DELETE_CLASS,
        "cd /work/follow9 && make && rm -rf build",
        "/workspace",
      ),
    ).toEqual([{ class: DELETE_CLASS, directory: "/work/follow9/build" }]);
    expect(
      grantCandidatesFor(
        DELETE_CLASS,
        "cd build && rm -rf out",
        "/home/mike/project",
      ),
    ).toEqual([
      { class: DELETE_CLASS, directory: "/home/mike/project/build/out" },
    ]);
  });

  it("offers nothing when the compound command does not say where it works", () => {
    for (const command of [
      "cd $WORK && rm -rf build",
      "cd $(mktemp -d) && rm -rf scratch",
      "cd /work/build && rm -rf ..",
    ]) {
      expect(
        grantCandidatesFor(DELETE_CLASS, command, "/home/mike/project"),
        command,
      ).toEqual([]);
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

  it("names the working directory for a target the command moved into", () => {
    expect(
      grantCandidatesFor(
        DELETE_CLASS,
        "cd build && rm -rf $BDIR",
        "/home/mike/pro",
      ),
    ).toEqual([{ class: DELETE_CLASS, directory: "/home/mike/pro/build" }]);
    expect(
      grantCandidatesFor("pattern:mkfs.", "mkfs.ext4 $DEV", "/mnt/usb"),
    ).toEqual([{ class: "pattern:mkfs.", directory: "/mnt/usb" }]);
  });

  it("offers a grant per directory when a delete spans several", () => {
    expect(
      grantCandidatesFor(
        DELETE_CLASS,
        "rm -rf /home/mike/Sync/build /tmp/build",
        "/home/mike",
        ["/tmp"],
      ),
    ).toEqual([
      { class: DELETE_CLASS, directory: "/home/mike/Sync/build" },
      { class: DELETE_CLASS, directory: "/tmp/build" },
    ]);
  });

  it("offers nothing when one spanned directory is not askable", () => {
    // /tmp/build is outside the directory the delete runs in and outside every
    // scratch root, so no part of this command can be granted.
    expect(
      grantCandidatesFor(
        DELETE_CLASS,
        "rm -rf build /tmp/build",
        "/home/mike/Sync",
      ),
    ).toEqual([]);
    expect(grantCandidatesFor(DELETE_CLASS, "rm -rf $BDIR", undefined)).toEqual(
      [],
    );
  });

  it("offers nothing whose directory is the home directory itself", () => {
    vi.stubEnv("HOME", "/home/mike");
    expect(
      grantCandidatesFor(DELETE_CLASS, "rm -rf /home/mike/build", "/tmp"),
    ).toEqual([]);
    // Even over a scratch root, the home directory itself is never granted.
    expect(
      grantCandidatesFor(DELETE_CLASS, "rm -rf /home/mike/*", "/tmp", [
        "/home/mike",
      ]),
    ).toEqual([]);
    vi.unstubAllEnvs();
  });
});

describe("describeGrant and describeGrants", () => {
  it("spells a delete grant as the directory it deletes", () => {
    expect(describeGrant({ class: DELETE_CLASS, directory: "/tmp/work" })).toBe(
      "recursive force delete of /tmp/work",
    );
    expect(
      describeGrant({ class: DELETE_CLASS, directory: "/tmp/work/build" }),
    ).toBe("recursive force delete of /tmp/work/build");
  });

  it("spells a grant for a class that only runs somewhere as under it", () => {
    expect(
      describeGrant({
        class: "pattern:docker run --privileged",
        directory: "/srv",
      }),
    ).toBe("docker run --privileged under /srv");
  });

  it("lists every directory an answer covers, naming the class once", () => {
    expect(
      describeGrants([
        { class: DELETE_CLASS, directory: "/home/mike/project/build" },
        { class: DELETE_CLASS, directory: "/home/mike/project/out" },
      ]),
    ).toBe("recursive force delete of ~/project/build, ~/project/out");
    expect(
      describeGrants([
        { class: DELETE_CLASS, directory: "/home/mike/project/build" },
        { class: "pattern:mkfs.", directory: "/mnt/usb" },
      ]),
    ).toBe("recursive force delete of ~/project/build; mkfs. under /mnt/usb");
  });

  it("counts the directories in a label once they no longer fit", () => {
    expect(
      describeGrantOffer(
        ["build", "out", "tests", "extra"].map((name) => ({
          class: DELETE_CLASS,
          directory: `/home/mike/project/${name}`,
        })),
      ),
    ).toBe("recursive force delete of 4 directories");
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

describe("saveCommandGrants", () => {
  const grant: CommandGrant = {
    class: DELETE_CLASS,
    directory: "/home/mike/project/build",
  };

  beforeEach(() => {
    vi.mocked(configLoader.getRawConfig).mockReturnValue(null);
    vi.mocked(configLoader.save).mockClear();
    vi.mocked(configLoader.getScopePath).mockReturnValue("/tmp/scope.json");
  });

  it("adds the grants to the scope's own config", async () => {
    vi.mocked(configLoader.getRawConfig).mockReturnValue({
      version: "0.16.2",
      pathAccess: { mode: "ask" },
      permissionGate: { requireConfirmation: true },
    });

    const saved = await saveCommandGrants([grant], "local");
    expect(saved).toEqual({
      scope: "local",
      path: "/tmp/scope.json",
      added: [grant],
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

  it("writes one entry per directory an answer covers", async () => {
    const others: CommandGrant[] = [
      { class: DELETE_CLASS, directory: "/home/mike/project/out" },
      { class: DELETE_CLASS, directory: "/home/mike/project/tests" },
    ];

    const saved = await saveCommandGrants([grant, ...others], "local");
    expect(saved.added).toHaveLength(3);
    const written = vi.mocked(configLoader.save).mock.calls[0]?.[1] as {
      permissionGate: { grants: CommandGrant[] };
    };
    expect(written.permissionGate.grants).toEqual([grant, ...others]);
  });

  it("keeps grants already in the scope", async () => {
    vi.mocked(configLoader.getRawConfig).mockReturnValue({
      permissionGate: {
        grants: [{ class: "pattern:shred", directory: "/data" }],
      },
    });

    await saveCommandGrants([grant], "memory");
    const written = vi.mocked(configLoader.save).mock.calls[0]?.[1] as {
      permissionGate: { grants: CommandGrant[] };
    };
    expect(written.permissionGate.grants).toEqual([
      { class: "pattern:shred", directory: "/data" },
      grant,
    ]);
  });

  it("does not save a grant the scope already holds", async () => {
    vi.mocked(configLoader.getRawConfig).mockReturnValue({
      permissionGate: { grants: [grant] },
    });

    const saved = await saveCommandGrants([grant], "global");
    expect(saved.added).toEqual([]);
    expect(vi.mocked(configLoader.save)).not.toHaveBeenCalled();
  });

  it("writes only what is missing when the scope holds part of the answer", async () => {
    vi.mocked(configLoader.getRawConfig).mockReturnValue({
      permissionGate: { grants: [grant] },
    });

    const other: CommandGrant = {
      class: DELETE_CLASS,
      directory: "/home/mike/project/out",
    };
    const saved = await saveCommandGrants([grant, other], "global");
    expect(saved.added).toEqual([other]);
    const written = vi.mocked(configLoader.save).mock.calls[0]?.[1] as {
      permissionGate: { grants: CommandGrant[] };
    };
    expect(written.permissionGate.grants).toEqual([grant, other]);
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
    expect(findGrantScope(grant)).toEqual({ scope: "memory", path: null });
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
