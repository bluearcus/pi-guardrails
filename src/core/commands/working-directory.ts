import type { Command, Program, SimpleCommand, Statement } from "@aliou/sh";
import { wordToString } from "../shell/ast";
import { NOT_LITERAL, normalizeAbsolutePath } from "./scratch";

/**
 * Where each command in a program runs.
 *
 * A compound command says where it works: `cd /work/follow9 && rm -rf $BDIR`
 * names the directory in the command itself. Treating any `cd` as making the
 * working directory unknowable throws that away, which leaves the delete with no
 * directory to grant and no scratch root to sit in — the commonest real shape
 * gets no answer at all. So the directory is followed through the parsed
 * program instead: a literal `cd` moves it, a `cd` whose target the shell fills
 * in loses it, and constructs whose bodies may not run, or may run more than
 * once, lose it too.
 *
 * Only statement nodes are tracked. A command inside a `$(…)` or `<(...)` runs
 * in a subshell of the command that carries the substitution, and finding which
 * one is not worth a parent chain: it is left untracked, which means unknown,
 * which means no exemption and no grant.
 */

/** Commands that change the shell's working directory. */
export const MOVES_WORKING_DIRECTORY = new Set(["cd", "pushd", "popd"]);

/** A directory the gate can name, or `undefined` when it cannot. */
export type WorkingDirectory = string | undefined;

/** `~` and `~/x` need the home directory, which only the caller knows. */
export interface WorkingDirectoryOptions {
  home?: string;
}

function commandName(cmd: SimpleCommand): string {
  const first = cmd.words?.[0];
  return first ? wordToString(first) : "";
}

/** The operands of a directory move, with its flags removed. */
function moveOperands(cmd: SimpleCommand): string[] {
  return (cmd.words ?? [])
    .slice(1)
    .map((word) => wordToString(word))
    .filter((word) => !word.startsWith("-"));
}

/**
 * Place a `cd` target against the directory the shell is in. A target the shell
 * fills in, or a home-relative target with no home to place it in, is unknown.
 */
function resolveMoveTarget(
  target: string,
  cwd: WorkingDirectory,
  options: WorkingDirectoryOptions,
): WorkingDirectory {
  const home = options.home;
  if (target === "~") return home;
  if (target.startsWith("~/")) {
    return home
      ? normalizeAbsolutePath(`${home}/${target.slice(2)}`)
      : undefined;
  }
  if (NOT_LITERAL.test(target)) return undefined;
  if (target.startsWith("/")) return normalizeAbsolutePath(target);
  return cwd ? normalizeAbsolutePath(`${cwd}/${target}`) : undefined;
}

/**
 * The directory after the shell runs one move command. Anything that depends on
 * shell state the gate cannot see — `cd` with no target (the home directory),
 * `cd -` (the previous directory), `popd` (the directory stack) — is unknown.
 */
function applyMove(
  cmd: SimpleCommand,
  cwd: WorkingDirectory,
  options: WorkingDirectoryOptions,
): WorkingDirectory {
  const operands = moveOperands(cmd);
  switch (commandName(cmd)) {
    case "cd":
      if (operands.length !== 1 || operands[0] === "-") return undefined;
      return resolveMoveTarget(operands[0], cwd, options);
    case "pushd":
      // `pushd` with no target swaps with the previous directory.
      if (operands.length !== 1) return undefined;
      return resolveMoveTarget(operands[0], cwd, options);
    case "popd":
      return undefined;
    default:
      return cwd;
  }
}

function isMove(cmd: SimpleCommand): boolean {
  return MOVES_WORKING_DIRECTORY.has(commandName(cmd));
}

interface State {
  cwd: WorkingDirectory;
  /** Whether a body being walked moved the directory at all. */
  moved: boolean;
}

function save(state: State): State {
  return { cwd: state.cwd, moved: state.moved };
}

function walkStatement(
  stmt: Statement,
  state: State,
  directories: Map<SimpleCommand, WorkingDirectory>,
  options: WorkingDirectoryOptions,
): void {
  walkCommand(stmt.command, state, directories, options);
}

function walkStatements(
  stmts: Statement[],
  state: State,
  directories: Map<SimpleCommand, WorkingDirectory>,
  options: WorkingDirectoryOptions,
): void {
  for (const stmt of stmts) walkStatement(stmt, state, directories, options);
}

/**
 * Walk a body whose effect on the outer directory is uncertain: an `if` branch
 * that may not run, a loop body that may run zero, one, or many times, a `case`
 * arm. The directory inside the body is known, so the commands in it are placed;
 * the directory afterwards is not, and is dropped.
 */
function walkUncertainBody(
  stmts: Statement[],
  state: State,
  directories: Map<SimpleCommand, WorkingDirectory>,
  options: WorkingDirectoryOptions,
): void {
  const moved = state.moved;
  walkStatements(stmts, state, directories, options);
  if (state.moved) {
    state.cwd = undefined;
    state.moved = true;
  } else {
    state.moved = moved;
  }
}

/**
 * Walk a body that cannot change the directory outside it: a subshell, a
 * pipeline element, a function definition body.
 */
function walkScopedBody(
  stmts: Statement[],
  state: State,
  directories: Map<SimpleCommand, WorkingDirectory>,
  options: WorkingDirectoryOptions,
): void {
  const outer = save(state);
  walkStatements(stmts, state, directories, options);
  state.cwd = outer.cwd;
  state.moved = outer.moved;
}

function walkCommand(
  cmd: Command,
  state: State,
  directories: Map<SimpleCommand, WorkingDirectory>,
  options: WorkingDirectoryOptions,
): void {
  switch (cmd.type) {
    case "SimpleCommand": {
      directories.set(cmd, state.cwd);
      if (isMove(cmd)) {
        state.cwd = applyMove(cmd, state.cwd, options);
        state.moved = true;
      }
      return;
    }

    case "Pipeline": {
      // Each element runs in its own subshell, so a `cd` in one says nothing
      // about the shell the rest of the program runs in.
      walkScopedBody(cmd.commands, state, directories, options);
      return;
    }

    case "Logical": {
      // `a && b`, `a || b`, `a ; b`, `a | b` as statements: left to right.
      walkStatement(cmd.left, state, directories, options);
      walkStatement(cmd.right, state, directories, options);
      return;
    }

    case "Subshell":
      walkScopedBody(cmd.body, state, directories, options);
      return;

    case "Block":
      // `{ cd /tmp; }` moves the directory of the shell that ran it.
      walkStatements(cmd.body, state, directories, options);
      return;

    case "IfClause": {
      walkStatements(cmd.cond, state, directories, options);
      walkUncertainBody(cmd.then, state, directories, options);
      if (cmd.else) walkUncertainBody(cmd.else, state, directories, options);
      return;
    }

    case "ForClause":
    case "SelectClause":
    case "WhileClause": {
      const cond = "cond" in cmd ? cmd.cond : undefined;
      if (cond) walkStatements(cond, state, directories, options);
      walkUncertainBody(cmd.body, state, directories, options);
      return;
    }

    case "CStyleLoop":
      // Its init/cond/post are arithmetic, not commands.
      walkUncertainBody(cmd.body, state, directories, options);
      return;

    case "CaseClause": {
      for (const item of cmd.items) {
        walkUncertainBody(item.body, state, directories, options);
      }
      return;
    }

    case "FunctionDecl": {
      // The body runs when the function is called, from wherever the call
      // happens. If it moves the directory, nothing after the definition can be
      // placed until a literal `cd` says where the shell is.
      const moved = bodyMoves(cmd.body);
      walkScopedBody(cmd.body, state, directories, options);
      if (moved) {
        state.cwd = undefined;
        state.moved = true;
      }
      return;
    }

    case "TimeClause":
      walkStatement(cmd.command, state, directories, options);
      return;

    case "CoprocClause":
      walkScopedBody([cmd.body], state, directories, options);
      return;

    case "TestClause":
    case "ArithCmd":
    case "DeclClause":
    case "LetClause":
      return;
  }
}

function bodyMoves(body: Statement[]): boolean {
  const probe = new Map<SimpleCommand, WorkingDirectory>();
  const state: State = { cwd: undefined, moved: false };
  walkStatements(body, state, probe, {});
  return state.moved;
}

/**
 * The directory every command in `program` runs in, keyed by AST node. A node
 * that is absent from the map is one this walk does not follow — inside a
 * command substitution — and must be treated as unplaceable.
 */
export function workingDirectoriesFor(
  program: Program,
  cwd: WorkingDirectory,
  options: WorkingDirectoryOptions = {},
): Map<SimpleCommand, WorkingDirectory> {
  const directories = new Map<SimpleCommand, WorkingDirectory>();
  const state: State = { cwd, moved: false };
  walkStatements(program.body ?? [], state, directories, options);
  return directories;
}

/**
 * Where the program leaves the shell: the directory a command with no path of
 * its own happens in.
 */
export function finalWorkingDirectory(
  program: Program,
  cwd: WorkingDirectory,
  options: WorkingDirectoryOptions = {},
): WorkingDirectory {
  const state: State = { cwd, moved: false };
  walkStatements(program.body ?? [], state, new Map(), options);
  return state.cwd;
}
