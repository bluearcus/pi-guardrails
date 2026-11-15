import { mkdirSync, symlinkSync } from "node:fs";
import { vol } from "memfs";
import { beforeEach, describe, expect, it } from "vitest";
import {
  builtinClassKey,
  type CommandGrant,
  commandClassKey,
  commandGrantCovers,
  commandGrantCoversAny,
  describeCommandClass,
  grantDirectoryFor,
  grantTargetsFor,
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

  it("does not cover a target that is the granted directory itself", () => {
    expect(
      commandGrantCovers(
        grant("/home/mike/project"),
        DELETE,
        ["/home/mike/project"],
        "/home/mike",
      ),
    ).toBe(false);
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

  it("does not cover a command that leaves the directory with one target there", () => {
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

  it("is covered by any grant in a list", () => {
    expect(
      commandGrantCoversAny(
        [grant("/tmp"), grant("/home/mike/project")],
        DELETE,
        ["/home/mike/project/build"],
        "/home/mike/project",
      ),
    ).toBe(true);
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

describe("grantDirectoryFor", () => {
  it("names the directory the target sits in", () => {
    expect(grantDirectoryFor(["/tmp/work/build"], "/tmp")).toBe("/tmp/work");
  });

  it("names the working directory for a relative target", () => {
    expect(grantDirectoryFor([".layout"], "/home/mike/project")).toBe(
      "/home/mike/project",
    );
  });

  it("names the working directory when a target cannot be placed", () => {
    expect(grantDirectoryFor(["$BDIR"], "/home/mike/project")).toBe(
      "/home/mike/project",
    );
    expect(grantDirectoryFor([], "/home/mike/project")).toBe(
      "/home/mike/project",
    );
  });

  it("names nothing when a target it cannot place is elsewhere", () => {
    expect(
      grantDirectoryFor(["$BDIR", "/tmp/a"], "/home/mike/project"),
    ).toBeUndefined();
    expect(grantDirectoryFor(["$BDIR"], undefined)).toBeUndefined();
  });

  it("names the directory several targets share", () => {
    expect(
      grantDirectoryFor(
        ["/home/mike/project/a/build", "/home/mike/project/b/out"],
        "/home/mike/project",
      ),
    ).toBe("/home/mike/project");
    expect(grantDirectoryFor(["/tmp/build"], undefined)).toBe("/tmp");
  });

  it("names nothing when the targets share no directory", () => {
    expect(
      grantDirectoryFor(["/home/mike/Sync", "/tmp/build"], "/home/mike"),
    ).toBeUndefined();
  });
});
