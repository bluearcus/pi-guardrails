import {
  deleteOperands,
  linksOnTheWayDown,
  NOT_LITERAL,
  normalizeAbsolutePath,
  RECURSIVE_FORCE_DELETE,
} from "./scratch";

/**
 * The `pattern` a built-in structural match reports, as opposed to the pattern
 * text of a configured pattern. A grant is taken for the rule that flagged the
 * command, so the two have to be told apart.
 */
export const STRUCTURAL_PATTERN = "(structural)";

/**
 * Directory grants for flagged command classes.
 *
 * An answer at a dangerous-command prompt is only worth having if it covers the
 * next command of the same kind, and the trust a user is granting is trust in a
 * place: recursive force delete is allowed where the task is happening, not
 * everywhere on the machine, and not for one spelling of one command line. A
 * grant is therefore a pair — the rule that flagged the command, and the
 * directory the action happens in.
 *
 * Coverage is checked target by target where the class has targets. For a
 * recursive force delete, every target has to sit inside the granted directory:
 * a literal path is placed against the working directory first, and a target
 * written as a variable or a wildcard is covered only when the command runs
 * inside the directory, because nothing can say where it lands. Classes without
 * path targets are covered where the command runs.
 */

/** The rule that flagged the class: a built-in matcher or a configured pattern. */
export type CommandClassKey = string;

export const BUILTIN_CLASS_PREFIX = "builtin:";
export const PATTERN_CLASS_PREFIX = "pattern:";

/** A class of flagged command allowed inside one directory. */
export interface CommandGrant {
  class: CommandClassKey;
  /** Absolute directory. A grant never covers the filesystem root. */
  directory: string;
}

/** The class of a built-in matcher's description. */
export function builtinClassKey(description: string): CommandClassKey {
  return `${BUILTIN_CLASS_PREFIX}${description}`;
}

/** The class of a configured pattern. */
export function patternClassKey(pattern: string): CommandClassKey {
  return `${PATTERN_CLASS_PREFIX}${pattern}`;
}

/** The class a flagged command was matched as. */
export function commandClassKey(match: {
  description: string;
  pattern: string;
}): CommandClassKey {
  return match.pattern === STRUCTURAL_PATTERN
    ? builtinClassKey(match.description)
    : patternClassKey(match.pattern);
}

/** What a class is called in a prompt or in settings. */
export function describeCommandClass(key: CommandClassKey): string {
  for (const prefix of [BUILTIN_CLASS_PREFIX, PATTERN_CLASS_PREFIX]) {
    if (key.startsWith(prefix)) return key.slice(prefix.length);
  }
  return key;
}

/**
 * A grant directory as a usable absolute path, or undefined for anything that
 * cannot be one: a relative path, a path with something the shell would expand,
 * or the filesystem root.
 */
export function normalizeGrantDirectory(
  directory: unknown,
): string | undefined {
  if (typeof directory !== "string") return undefined;
  const raw = directory.trim();
  if (!raw || NOT_LITERAL.test(raw)) return undefined;
  const path = normalizeAbsolutePath(raw);
  return path && path !== "/" ? path : undefined;
}

/** Whether a path is the directory itself or below it. */
export function insideDirectory(path: string, directory: string): boolean {
  return path === directory || path.startsWith(`${directory}/`);
}

/**
 * The targets a grant has to place. Only the recursive force delete class names
 * paths; every other class is granted where its command runs.
 */
export function grantTargetsFor(
  classKey: CommandClassKey,
  words: readonly string[],
): string[] {
  return classKey === builtinClassKey(RECURSIVE_FORCE_DELETE)
    ? deleteOperands(words)
    : [];
}

/**
 * Whether one grant covers a flagged command. `targets` are the operand words
 * the command names, `cwd` the directory it runs in, already dropped by the
 * caller when the command moves it itself.
 */
export function commandGrantCovers(
  grant: CommandGrant,
  classKey: CommandClassKey,
  targets: readonly string[],
  cwd: string | undefined,
): boolean {
  if (grant.class !== classKey) return false;
  const directory = normalizeGrantDirectory(grant.directory);
  if (!directory) return false;

  if (targets.length === 0)
    return cwd !== undefined && insideDirectory(cwd, directory);

  for (const target of targets) {
    if (NOT_LITERAL.test(target)) {
      // A target the shell fills in cannot be placed, so the only thing a grant
      // can check is where the command runs.
      if (!cwd || !insideDirectory(cwd, directory)) return false;
      continue;
    }

    const path = target.startsWith("/")
      ? normalizeAbsolutePath(target)
      : cwd
        ? normalizeAbsolutePath(`${cwd}/${target}`)
        : undefined;
    if (!path) return false;
    if (path === directory) return false;
    if (!insideDirectory(path, directory)) return false;

    const hazard = linksOnTheWayDown(path, directory);
    if (hazard.link || hazard.unreadable) return false;
  }

  return true;
}

/** Whether any grant covers a flagged command. */
export function commandGrantCoversAny(
  grants: readonly CommandGrant[],
  classKey: CommandClassKey,
  targets: readonly string[],
  cwd: string | undefined,
): boolean {
  return grants.some((grant) =>
    commandGrantCovers(grant, classKey, targets, cwd),
  );
}

/**
 * The directory a grant should name for a flagged command: the deepest directory
 * that would actually cover it. Literal targets contribute the directory they
 * sit in; a target the shell fills in contributes the working directory, because
 * that is all a grant can check for it. Undefined when the action spans
 * directories no single grant covers.
 */
export function grantDirectoryFor(
  targets: readonly string[],
  cwd: string | undefined,
): string | undefined {
  const required: string[] = [];
  for (const target of targets) {
    if (NOT_LITERAL.test(target)) {
      const directory = normalizeGrantDirectory(cwd);
      if (!directory) return undefined;
      required.push(directory);
      continue;
    }

    const path = target.startsWith("/")
      ? normalizeAbsolutePath(target)
      : cwd
        ? normalizeAbsolutePath(`${cwd}/${target}`)
        : undefined;
    if (!path) return undefined;
    required.push(path.slice(0, path.lastIndexOf("/")) || "/");
  }

  if (required.length === 0) return normalizeGrantDirectory(cwd);

  let common = required[0] as string;
  for (const directory of required.slice(1)) {
    while (directory !== common && !directory.startsWith(`${common}/`)) {
      const cut = common.lastIndexOf("/");
      if (cut <= 0) return undefined;
      common = common.slice(0, cut);
    }
  }
  return normalizeGrantDirectory(common);
}
