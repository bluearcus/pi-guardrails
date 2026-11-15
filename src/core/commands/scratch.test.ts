import { mkdirSync, symlinkSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { classifyScratchDelete, normalizeScratchRoots } from "./scratch";

const scope = { roots: ["/tmp"] };

describe("normalizeScratchRoots", () => {
  it("keeps absolute directories normalized and relative ones as written", () => {
    expect(
      normalizeScratchRoots([
        "/tmp/",
        "/var/tmp",
        "/",
        "relative",
        "./build/",
        "",
        5 as never,
      ]),
    ).toEqual(["/tmp", "/var/tmp", "relative", "./build"]);
  });

  it("does not list a root twice", () => {
    expect(normalizeScratchRoots(["/tmp", "/tmp/", "/tmp/x/.."])).toEqual([
      "/tmp",
    ]);
  });
});

describe("classifyScratchDelete", () => {
  it("excuses deleting a scratch directory the agent made", () => {
    expect(
      classifyScratchDelete(["rm", "-rf", "/tmp/b1"], scope).confined,
    ).toBe(true);
    expect(
      classifyScratchDelete(
        ["rm", "-r", "-f", "/tmp/scrport/scr", "/tmp/b1/deep/nested"],
        scope,
      ).confined,
    ).toBe(true);
    expect(
      classifyScratchDelete(
        ["rm", "--recursive", "--force", "--", "/tmp/x"],
        scope,
      ).confined,
    ).toBe(true);
  });

  it("still flags deleting the whole scratch root", () => {
    const verdict = classifyScratchDelete(["rm", "-rf", "/tmp"], scope);
    expect(verdict.confined).toBe(false);
    if (verdict.confined) return;
    expect(verdict.reason).toContain("whole scratch root");
  });

  it("still flags a target outside the scratch roots", () => {
    expect(
      classifyScratchDelete(["rm", "-rf", "/home/mike/Sync"], scope).confined,
    ).toBe(false);
    expect(
      classifyScratchDelete(["rm", "-rf", "/tmp", "/tmp/b1"], scope).confined,
    ).toBe(false);
    expect(
      classifyScratchDelete(["rm", "-rf", "/tmp/../etc"], scope).confined,
    ).toBe(false);
  });

  it("still flags a relative target when the working directory is not known", () => {
    const verdict = classifyScratchDelete(["rm", "-rf", "tmp/b1"], scope);
    expect(verdict.confined).toBe(false);
    if (verdict.confined) return;
    expect(verdict.reason).toContain("relative");
  });

  it("places a relative target in the working directory it runs in", () => {
    const working = { roots: ["/tmp"], cwd: "/tmp/work" };

    expect(
      classifyScratchDelete(["rm", "-rf", "build"], working).confined,
    ).toBe(true);
    expect(
      classifyScratchDelete(["rm", "-rf", "./build/deep"], working).confined,
    ).toBe(true);

    // The same relative target from a working directory outside the scratch
    // root is a delete somewhere else entirely.
    const elsewhere = { roots: ["/tmp"], cwd: "/home/mike/project" };
    const verdict = classifyScratchDelete(["rm", "-rf", "build"], elsewhere);
    expect(verdict.confined).toBe(false);
    if (verdict.confined) return;
    expect(verdict.reason).toContain("outside the scratch roots");
  });

  it("takes a scratch root relative to the working directory", () => {
    const scopeForProject = { roots: ["build"], cwd: "/home/mike/project" };

    expect(
      classifyScratchDelete(["rm", "-rf", "build/out"], scopeForProject)
        .confined,
    ).toBe(true);

    // Deleting the declared root itself is still the whole root.
    const verdict = classifyScratchDelete(
      ["rm", "-rf", "build"],
      scopeForProject,
    );
    expect(verdict.confined).toBe(false);
    if (verdict.confined) return;
    expect(verdict.reason).toContain("whole scratch root");
  });

  it("still flags a wildcard, which can match other people's scratch data", () => {
    expect(classifyScratchDelete(["rm", "-rf", "/tmp/*"], scope).confined).toBe(
      false,
    );
    expect(
      classifyScratchDelete(["rm", "-rf", "/tmp/build?.d"], scope).confined,
    ).toBe(false);
  });

  it("still flags a target that is not written out literally", () => {
    expect(
      classifyScratchDelete(["rm", "-rf", "/tmp/$DIR"], scope).confined,
    ).toBe(false);
    expect(
      classifyScratchDelete(["rm", "-rf", "/tmp/$(pwd)"], scope).confined,
    ).toBe(false);
  });

  it("reads a trailing slash as the same directory", () => {
    expect(
      classifyScratchDelete(["rm", "-rf", "/tmp/b1/"], scope).confined,
    ).toBe(true);
  });

  it("still flags deleting a root through its trailing slash", () => {
    const verdict = classifyScratchDelete(["rm", "-rf", "/tmp/"], scope);
    expect(verdict.confined).toBe(false);
    if (verdict.confined) return;
    expect(verdict.reason).toContain("whole scratch root");
  });

  it("still flags the filesystem root", () => {
    const verdict = classifyScratchDelete(["rm", "-rf", "/"], scope);
    expect(verdict.confined).toBe(false);
    if (verdict.confined) return;
    expect(verdict.reason).toContain("filesystem root");
  });

  it("still flags a path that passes through a symlink", () => {
    mkdirSync("/tmp/escape", { recursive: true });
    symlinkSync("/home/mike/Sync", "/tmp/escape/link");
    const verdict = classifyScratchDelete(
      ["rm", "-rf", "/tmp/escape/link/inner"],
      scope,
    );
    expect(verdict.confined).toBe(false);
    if (verdict.confined) return;
    expect(verdict.reason).toContain("through the symlink /tmp/escape/link");
  });

  it("excuses unlinking a symlink itself, which rm does not follow", () => {
    mkdirSync("/tmp/unlink", { recursive: true });
    symlinkSync("/home/mike/Sync", "/tmp/unlink/link");
    expect(
      classifyScratchDelete(["rm", "-rf", "/tmp/unlink/link"], scope).confined,
    ).toBe(true);
  });

  it("flags a delete with no target to check", () => {
    expect(classifyScratchDelete(["rm", "-rf"], scope).confined).toBe(false);
  });

  it("flags when no scratch root is configured", () => {
    expect(
      classifyScratchDelete(["rm", "-rf", "/tmp/b1"], { roots: [] }).confined,
    ).toBe(false);
  });

  it("accepts several configured roots", () => {
    expect(
      classifyScratchDelete(["rm", "-rf", "/var/tmp/build", "/tmp/build"], {
        roots: ["/tmp", "/var/tmp"],
      }).confined,
    ).toBe(true);
  });
});
