import { mkdirSync, symlinkSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { classifyScratchDelete, normalizeScratchRoots } from "./scratch";

const scope = { roots: ["/tmp"] };

describe("normalizeScratchRoots", () => {
  it("keeps absolute directories and drops the rest", () => {
    expect(
      normalizeScratchRoots([
        "/tmp/",
        "/var/tmp",
        "/",
        "relative",
        "",
        5 as never,
      ]),
    ).toEqual(["/tmp", "/var/tmp"]);
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

  it("still flags a relative target, which depends on the working directory", () => {
    const verdict = classifyScratchDelete(["rm", "-rf", "tmp/b1"], scope);
    expect(verdict.confined).toBe(false);
    if (verdict.confined) return;
    expect(verdict.reason).toContain("relative");
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

  it("still flags a trailing slash, which makes rm follow a linked directory", () => {
    const verdict = classifyScratchDelete(["rm", "-rf", "/tmp/b1/"], scope);
    expect(verdict.confined).toBe(false);
    if (verdict.confined) return;
    expect(verdict.reason).toContain("follow a symlinked directory");
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
