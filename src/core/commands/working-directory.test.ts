import { type Program, parse } from "@aliou/sh";
import { describe, expect, it } from "vitest";
import { walkCommands, wordToString } from "../shell/ast";
import {
  finalWorkingDirectory,
  MOVES_WORKING_DIRECTORY,
  workingDirectoriesFor,
} from "./working-directory";

const PROJECT = "/home/mike/project";
const HOME = "/home/mike";

function astOf(command: string): Program {
  const result = parse(command, { recoverErrors: true });
  return result.ast;
}

/** The directory of the last command word in the program. */
function directoryOf(
  command: string,
  cwd: string | undefined = PROJECT,
  home?: string,
): string | undefined {
  const ast = astOf(command);
  const directories = workingDirectoriesFor(ast, cwd, { home });
  let last: string | undefined;
  let found = false;
  walkCommands(ast, (cmd) => {
    if (!cmd) return false;
    const words = (cmd.words ?? []).map(wordToString);
    if (words.length === 0) return false;
    last = directories.get(cmd);
    found = true;
    return false;
  });
  return found ? last : undefined;
}

/** The directory of every command whose first word is `name`. */
function directoriesOfCommand(
  name: string,
  command: string,
  cwd: string | undefined = PROJECT,
): (string | undefined)[] {
  const ast = astOf(command);
  const directories = workingDirectoriesFor(ast, cwd);
  const found: (string | undefined)[] = [];
  walkCommands(ast, (cmd) => {
    if (!cmd) return false;
    const words = (cmd.words ?? []).map(wordToString);
    if (words[0] === name) found.push(directories.get(cmd));
    return false;
  });
  return found;
}

/** The directory of the command whose first word is `name`. */
function directoryOfCommand(
  name: string,
  command: string,
  cwd: string | undefined = PROJECT,
): string | undefined {
  const ast = astOf(command);
  const directories = workingDirectoriesFor(ast, cwd);
  let found: string | undefined;
  let seen = false;
  walkCommands(ast, (cmd) => {
    if (!cmd) return false;
    const words = (cmd.words ?? []).map(wordToString);
    if (words[0] !== name) return false;
    found = directories.get(cmd);
    seen = true;
    return true;
  });
  return seen ? found : undefined;
}

describe("workingDirectoriesFor", () => {
  it("places every command in the directory the call started in when nothing moves it", () => {
    expect(directoryOfCommand("make", "make && rm -rf build")).toBe(PROJECT);
    expect(directoryOfCommand("rm", "make && rm -rf build")).toBe(PROJECT);
  });

  it("follows a literal cd into the directory it names", () => {
    expect(
      directoryOfCommand(
        "rm",
        "cd /work/follow9/build && make && rm -rf $BDIR",
        PROJECT,
      ),
    ).toBe("/work/follow9/build");
  });

  it("resolves a relative cd against the directory the shell is in", () => {
    expect(directoryOfCommand("rm", "cd build && rm -rf out")).toBe(
      `${PROJECT}/build`,
    );
    expect(directoryOfCommand("rm", "cd build/debug && rm -rf out")).toBe(
      `${PROJECT}/build/debug`,
    );
    expect(directoryOfCommand("rm", "cd build && cd .. && rm -rf old")).toBe(
      PROJECT,
    );
  });

  it("places a home-relative cd when it is told the home directory", () => {
    expect(directoryOf("cd ~/work && rm -rf build", PROJECT, HOME)).toBe(
      `${HOME}/work`,
    );
    expect(directoryOf("cd ~ && rm -rf build", PROJECT, HOME)).toBe(HOME);
    // Without a home to place it in the directory is not known.
    expect(directoryOf("cd ~/work && rm -rf build", PROJECT)).toBeUndefined();
  });

  it("loses the directory for a cd it cannot resolve", () => {
    expect(
      directoryOfCommand("rm", "cd $WORK && rm -rf build"),
    ).toBeUndefined();
    expect(
      directoryOfCommand("rm", "cd $(mktemp -d) && rm -rf scratch"),
    ).toBeUndefined();
    expect(directoryOfCommand("rm", "cd - && rm -rf old")).toBeUndefined();
    expect(directoryOfCommand("rm", "cd && rm -rf build")).toBeUndefined();
    expect(
      directoryOfCommand("rm", "cd /a /b && rm -rf build"),
    ).toBeUndefined();
  });

  it("follows pushd and loses the directory on popd", () => {
    expect(directoriesOfCommand("rm", "pushd build && rm -rf out")).toEqual([
      `${PROJECT}/build`,
    ]);
    expect(
      directoriesOfCommand(
        "rm",
        "pushd /work && rm -rf out && popd && rm -rf x",
      ),
    ).toEqual(["/work", undefined]);
  });

  it("keeps the directory a subshell chose inside it and not outside", () => {
    expect(directoryOfCommand("rm", "(cd /tmp && rm -rf inner)")).toBe("/tmp");
    expect(
      directoryOf("(cd /tmp && rm -rf inner) && rm -rf outer", PROJECT),
    ).toBe(PROJECT);
  });

  it("keeps the directory a brace group chose, because it moved the shell", () => {
    expect(
      directoryOf("{ cd /tmp; rm -rf inner; } && rm -rf outer", PROJECT),
    ).toBe("/tmp");
  });

  it("ignores a cd inside a pipeline, which runs in its own subshell", () => {
    expect(directoryOf("cd /tmp | tee log && rm -rf build", PROJECT)).toBe(
      PROJECT,
    );
  });

  it("places commands inside a loop in the loop's directory, then loses it", () => {
    expect(
      directoryOfCommand("rm", "cd /tmp && for d in a b; do rm -rf $d; done"),
    ).toBe("/tmp");
    expect(
      directoryOf(
        "cd /tmp && for d in a b; do cd $d; done && rm -rf x",
        PROJECT,
      ),
    ).toBeUndefined();
  });

  it("places commands inside a branch, then loses the directory it may have moved", () => {
    expect(
      directoryOfCommand("rm", "if test -d build; then rm -rf build; fi"),
    ).toBe(PROJECT);
    expect(
      directoryOf("if test -d build; then cd build; fi && rm -rf out", PROJECT),
    ).toBeUndefined();
  });

  it("loses the directory after a function definition that moves it", () => {
    expect(
      directoryOf("go() { cd /tmp; } && rm -rf build", PROJECT),
    ).toBeUndefined();
    // A definition that does not move it says nothing about where the shell is.
    expect(directoryOf("go() { echo hi; } && rm -rf build", PROJECT)).toBe(
      PROJECT,
    );
  });

  it("follows the program in order, not the last cd in it", () => {
    expect(
      directoriesOfCommand("rm", "rm -rf first && cd /tmp && rm -rf second"),
    ).toEqual([PROJECT, "/tmp"]);
  });

  it("leaves a command inside a command substitution untracked", () => {
    const ast = astOf("cd /tmp && echo $(rm -rf inner)");
    const directories = workingDirectoriesFor(ast, PROJECT);
    const tracked = new Set(directories.keys());
    const visited: string[] = [];
    walkCommands(
      ast,
      (cmd) => {
        if (!cmd) return false;
        const words = (cmd.words ?? []).map(wordToString);
        if (tracked.has(cmd)) return false;
        visited.push(words.join(" "));
        return false;
      },
      { includeSubstitutions: true },
    );
    expect(visited).toEqual(["rm -rf inner"]);
  });

  it("places every command the shared walk visits at statement level", () => {
    const corpus = [
      "rm -rf build",
      "cd build && rm -rf out",
      "a && b && c",
      "a | b | c",
      "for d in a b; do rm -rf $d; done",
      "while read l; do rm -rf $l; done < list",
      "case $x in a) rm -rf a;; *) rm -rf b;; esac",
      "if a; then b; else c; fi",
      "{ cd /tmp; rm -rf x; } > log",
      "(cd /tmp; rm -rf x)",
      "f() { cd /tmp; rm -rf x; }",
      "time rm -rf build",
      "x=1 rm -rf build",
      "(( i = 1 ))",
      "let i++",
      "until test -e x; do cd build; done",
      "select d in a b; do rm -rf $d; done",
    ];
    for (const command of corpus) {
      const ast = astOf(command);
      const tracked = workingDirectoriesFor(ast, PROJECT);
      const missed: string[] = [];
      walkCommands(ast, (cmd) => {
        if (!cmd) return false;
        if (!tracked.has(cmd)) {
          missed.push((cmd.words ?? []).map(wordToString).join(" "));
        }
        return false;
      });
      expect(missed, command).toEqual([]);
    }
  });
});

describe("MOVES_WORKING_DIRECTORY", () => {
  it("names the commands that change where a command runs", () => {
    expect([...MOVES_WORKING_DIRECTORY].sort()).toEqual([
      "cd",
      "popd",
      "pushd",
    ]);
  });
});

describe("finalWorkingDirectory", () => {
  it("is where the program leaves the shell", () => {
    expect(finalWorkingDirectory(astOf("cd /tmp && make"), PROJECT)).toBe(
      "/tmp",
    );
    expect(finalWorkingDirectory(astOf("make && cd /tmp"), PROJECT)).toBe(
      "/tmp",
    );
    expect(finalWorkingDirectory(astOf("(cd /tmp) && make"), PROJECT)).toBe(
      PROJECT,
    );
    expect(
      finalWorkingDirectory(astOf("cd $WORK && make"), PROJECT),
    ).toBeUndefined();
    expect(finalWorkingDirectory(astOf("make"), undefined)).toBeUndefined();
  });
});
