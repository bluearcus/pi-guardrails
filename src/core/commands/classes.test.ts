import { mkdirSync, symlinkSync } from "node:fs";
import { vol } from "memfs";
import { beforeEach, describe, expect, it } from "vitest";
import {
  builtinClassKey,
  type CommandGrant,
  commandClassKey,
  commandGrantCovers,
  commandGrantsCover,
  describeCommandClass,
  grantCoversDirectory,
  grantTargetsFor,
  impactedDirectoriesFor,
  literalTargetDirectory,
  normalizeGrantDirectory,
  patternClassKey,
  RECURSIVE_FORCE_DELETE,
  STRUCTURAL_PATTERN,
} from "./index";

const DELETE = builtinClassKey(RECURSIVE_FORCE_DELETE);

function grant(directory: string, classKey: string = DELETE): CommandGrant {
  return { class: classKey, directory };
}

describe("commandClassKey", () => {
  it("names a built-in match by its description", () => {
    expect(
      commandClassKey({
        description: RECURSIVE_FORCE_DELETE,
        pattern: STRUCTURAL_PATTERN,
      }),
    ).toBe("builtin:recursive force delete");
  });

  it("names a configured match by its pattern", () => {
    expect(
      commandClassKey({ description: "wipe", pattern: "terraform\\s+destroy" }),
    ).toBe("pattern:terraform\\s+destroy");
  });

  it("labels a class without its prefix", () => {
    expect(describeCommandClass("builtin:recursive force delete")).toBe(
      "recursive force delete",
    );
    expect(describeCommandClass("pattern:rm -rf")).toBe("rm -rf");
    expect(describeCommandClass("sudo apt update")).toBe("sudo apt update");
  });
});

describe("normalizeGrantDirectory", () => {
  it("keeps an absolute directory and resolves . and ..", () => {
    expect(normalizeGrantDirectory("/tmp/work")).toBe("/tmp/work");
    expect(normalizeGrantDirectory("/tmp/work/")).toBe("/tmp/work");
    expect(normalizeGrantDirectory("/tmp/other/../work/.")).toBe("/tmp/work");
  });

  it("refuses anything that is not a directory it can name", () => {
    expect(normalizeGrantDirectory("/")).toBeUndefined();
    expect(normalizeGrantDirectory("/tmp/../")).toBeUndefined();
    expect(normalizeGrantDirectory("relative/build")).toBeUndefined();
    expect(normalizeGrantDirectory("/tmp/$BUILD")).toBeUndefined();
    expect(normalizeGrantDirectory("/tmp/*")).toBeUndefined();
    expect(normalizeGrantDirectory("/tmp/~user")).toBeUndefined();
    expect(normalizeGrantDirectory("")).toBeUndefined();
    expect(normalizeGrantDirectory(undefined)).toBeUndefined();
    expect(normalizeGrantDirectory(7)).toBeUndefined();
  });
});

describe("commandGrantCovers", () => {
  beforeEach(() => {
    vol.reset();
  });

  it("covers a target inside the granted directory", () => {
    expect(
      commandGrantCovers(
        grant("/home/mike/project"),
        DELETE,
        ["/home/mike/project/build"],
        undefined,
      ),
    ).toBe(true);
  });

  it("covers a target outside the scratch roots but inside the grant", () => {
    expect(
      commandGrantCovers(
        grant("/home/mike/project"),
        DELETE,
        ["/home/mike/project/.layout"],
        "/home/mike/project",
      ),
    ).toBe(true);
  });

  it("does not cover a target in another directory", () => {
    expect(
      commandGrantCovers(
        grant("/home/mike/project"),
        DELETE,
        ["/home/mike/Sync"],
        "/home/mike/project",
      ),
    ).toBe(false);
  });

  it("covers the granted directory itself, which is what a delete grant names", () => {
    expect(
      commandGrantCovers(
        grant("/home/mike/project/scratch"),
        DELETE,
        ["/home/mike/project/scratch"],
        "/home/mike/project",
      ),
    ).toBe(true);
  });

  it("covers a target that is the granted directory spelled as a relative path", () => {
    expect(
      commandGrantCovers(
        grant("/home/mike/project/scratch"),
        DELETE,
        ["scratch", "scratch/"],
        "/home/mike/project",
      ),
    ).toBe(true);
  });

  it("places a relative target in the working directory", () => {
    expect(
      commandGrantCovers(
        grant("/home/mike/project"),
        DELETE,
        ["build", "./out/deep"],
        "/home/mike/project",
      ),
    ).toBe(true);
    expect(
      commandGrantCovers(
        grant("/home/mike/project"),
        DELETE,
        ["build"],
        "/home/mike/elsewhere",
      ),
    ).toBe(false);
    expect(
      commandGrantCovers(grant("/tmp/work"), DELETE, ["build"], undefined),
    ).toBe(false);
  });

  it("does not cover a relative target that climbs out of the grant", () => {
    expect(
      commandGrantCovers(
        grant("/home/mike/project/build"),
        DELETE,
        ["../outside"],
        "/home/mike/project/build",
      ),
    ).toBe(false);
  });

  it("covers a target it cannot place only when the command runs inside", () => {
    expect(
      commandGrantCovers(
        grant("/home/mike/project"),
        DELETE,
        ["$BDIR"],
        "/home/mike/project/tests",
      ),
    ).toBe(true);
    expect(
      commandGrantCovers(
        grant("/home/mike/project"),
        DELETE,
        ["$BDIR"],
        "/tmp",
      ),
    ).toBe(false);
    expect(
      commandGrantCovers(
        grant("/home/mike/project"),
        DELETE,
        ["$BDIR"],
        undefined,
      ),
    ).toBe(false);
  });

  it("does not cover two directories with a grant for one of them", () => {
    expect(
      commandGrantCovers(
        grant("/home/mike/project"),
        DELETE,
        ["/home/mike/project/build", "/home/mike/Sync"],
        "/home/mike/project",
      ),
    ).toBe(false);
  });

  it("covers a class with no path targets where the command runs", () => {
    const sudo = builtinClassKey("superuser command");
    expect(
      commandGrantCovers(grant("/tmp/work", sudo), sudo, [], "/tmp/work/sub"),
    ).toBe(true);
    expect(
      commandGrantCovers(grant("/tmp/work", sudo), sudo, [], "/home/mike"),
    ).toBe(false);
  });

  it("does not cover another class", () => {
    expect(
      commandGrantCovers(
        grant("/home/mike/project", patternClassKey("rm -rf")),
        DELETE,
        ["/home/mike/project/build"],
        "/home/mike/project",
      ),
    ).toBe(false);
  });

  it("does not cover a target reached through a link", () => {
    mkdirSync("/home/mike/project", { recursive: true });
    symlinkSync("/home/mike/Sync", "/home/mike/project/link");
    expect(
      commandGrantCovers(
        grant("/home/mike/project"),
        DELETE,
        ["/home/mike/project/link/inner"],
        "/home/mike/project",
      ),
    ).toBe(false);
  });

  it("is covered by grants taken for each directory the command impacts", () => {
    expect(
      commandGrantsCover(
        [grant("/home/mike/project/build"), grant("/tmp/a")],
        DELETE,
        ["/home/mike/project/build", "/tmp/a"],
        "/home/mike/project",
      ),
    ).toBe(true);
  });

  it("is not covered while one impacted directory has no grant of its own", () => {
    expect(
      commandGrantsCover(
        [grant("/home/mike/project/build")],
        DELETE,
        ["/home/mike/project/build", "/home/mike/project/out"],
        "/home/mike/project",
      ),
    ).toBe(false);
    expect(
      commandGrantsCover(
        [grant("/home/mike/project")],
        DELETE,
        ["/home/mike/project/build", "/home/mike/Sync"],
        "/home/mike/project",
      ),
    ).toBe(false);
  });

  it("says nothing for a class no grant names", () => {
    expect(
      commandGrantsCover([], DELETE, ["/home/mike/project/build"], undefined),
    ).toBe(false);
    expect(
      commandGrantsCover(
        [grant("/tmp", builtinClassKey("superuser command"))],
        DELETE,
        [],
        "/tmp",
      ),
    ).toBe(false);
  });
});

describe("grantTargetsFor", () => {
  it("takes the operands of a delete and nothing else", () => {
    expect(
      grantTargetsFor(DELETE, ["rm", "-rf", "/tmp/b1", "--", "x"]),
    ).toEqual(["/tmp/b1", "x"]);
    expect(
      grantTargetsFor(builtinClassKey("superuser command"), ["sudo", "ls"]),
    ).toEqual([]);
  });
});

describe("grantCoversDirectory", () => {
  it("covers the directory a grant names and what is under it", () => {
    const held = grant("/tmp/work/build");
    expect(
      grantCoversDirectory(held, DELETE, "/tmp/work/build", undefined),
    ).toBe(true);
    expect(
      grantCoversDirectory(held, DELETE, "/tmp/work/build/cache", "/tmp/work"),
    ).toBe(true);
  });

  it("does not cover the directory above the one it names, or a sibling", () => {
    const held = grant("/tmp/work/build");
    expect(grantCoversDirectory(held, DELETE, "/tmp/work", undefined)).toBe(
      false,
    );
    expect(grantCoversDirectory(held, DELETE, "/tmp/work/out", undefined)).toBe(
      false,
    );
  });

  it("counts only for the class the grant was taken for", () => {
    const held = grant("/tmp/work/build");
    expect(
      grantCoversDirectory(
        held,
        patternClassKey("rm -rf"),
        "/tmp/work/build",
        undefined,
      ),
    ).toBe(false);
  });
});

describe("impactedDirectoriesFor", () => {
  it("names the directory a literal target is", () => {
    expect(impactedDirectoriesFor(["/tmp/work/build"], "/tmp")).toEqual([
      "/tmp/work/build",
    ]);
    expect(impactedDirectoriesFor(["build/out/deep"], "/tmp")).toEqual([
      "/tmp/build/out/deep",
    ]);
  });

  it("names the target itself, never the directory holding it", () => {
    expect(impactedDirectoriesFor(["scratch"], "/home/mike/project")).toEqual([
      "/home/mike/project/scratch",
    ]);
    expect(impactedDirectoriesFor(["scratch/"], "/home/mike/project")).toEqual([
      "/home/mike/project/scratch",
    ]);
  });

  it("names each of several targets, keeping the order they were written in", () => {
    expect(
      impactedDirectoriesFor(
        ["/home/mike/project/build", "/home/mike/project/out"],
        "/home/mike/project",
      ),
    ).toEqual(["/home/mike/project/build", "/home/mike/project/out"]);
  });

  it("names one directory once when targets repeat it", () => {
    expect(
      impactedDirectoriesFor(
        ["build", "/home/mike/project/build", "build/"],
        "/home/mike/project",
      ),
    ).toEqual(["/home/mike/project/build"]);
  });

  it("names the directory a pattern deletes inside", () => {
    expect(impactedDirectoriesFor(["build/*"], "/home/mike/project")).toEqual([
      "/home/mike/project/build",
    ]);
    expect(impactedDirectoriesFor(["/tmp/build/*"], undefined)).toEqual([
      "/tmp/build",
    ]);
  });

  it("names the working directory for a target the shell fills in", () => {
    expect(impactedDirectoriesFor(["$BDIR"], "/home/mike/project")).toEqual([
      "/home/mike/project",
    ]);
    expect(impactedDirectoriesFor(["$BDIR", "/tmp/a"], "/tmp")).toEqual([
      "/tmp",
      "/tmp/a",
    ]);
  });

  it("names nothing when a target cannot be placed", () => {
    expect(impactedDirectoriesFor(["$BDIR"], undefined)).toBeUndefined();
    expect(impactedDirectoriesFor(["../outside"], undefined)).toBeUndefined();
    expect(impactedDirectoriesFor([], "/home/mike/project")).toBeUndefined();
    expect(impactedDirectoriesFor(["/"], "/home/mike/project")).toBeUndefined();
  });
});

describe("literalTargetDirectory", () => {
  it("reads the directory a pattern deletes inside", () => {
    expect(literalTargetDirectory("/tmp/*", "/home/mike/project")).toBe("/tmp");
    expect(literalTargetDirectory("build/*", "/home/mike/project")).toBe(
      "/home/mike/project/build",
    );
    expect(literalTargetDirectory("/tmp/build/*", undefined)).toBe(
      "/tmp/build",
    );
  });

  it("says nothing about a target the shell fills in", () => {
    expect(
      literalTargetDirectory("$BDIR", "/home/mike/project"),
    ).toBeUndefined();
    expect(
      literalTargetDirectory("$(mktemp -d)/x", "/home/mike/project"),
    ).toBeUndefined();
    expect(
      literalTargetDirectory("$BDIR/build", "/home/mike/project"),
    ).toBeUndefined();
  });
});

describe("commandGrantCovers with a wildcard target", () => {
  const grant: CommandGrant = {
    class: builtinClassKey(RECURSIVE_FORCE_DELETE),
    directory: "/home/mike/project",
  };

  it("covers a wildcard whose literal part sits inside the grant", () => {
    expect(
      commandGrantCovers(
        grant,
        grant.class,
        ["/home/mike/project/build/*"],
        "/home/mike/project",
      ),
    ).toBe(true);
  });

  it("does not cover a wildcard that deletes somewhere else", () => {
    expect(
      commandGrantCovers(grant, grant.class, ["/tmp/*"], "/home/mike/project"),
    ).toBe(false);
    expect(
      commandGrantCovers(
        grant,
        grant.class,
        ["/home/mike/other/*"],
        "/home/mike/project",
      ),
    ).toBe(false);
  });
});
