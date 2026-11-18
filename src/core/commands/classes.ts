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
 * place: recursive force delete is allowed for the directory the delete hits,
 * not for everything around it, not everywhere on the machine, and not for one
 * spelling of one command line. A grant is therefore a pair — the rule that
 * flagged the command, and the directory the action impacts.
 *
 * The directory a delete grant names is the directory it deletes: `rm -rf
 * scratch` is a grant for `<cwd>/scratch`, which says nothing about the rest of
 * the tree that scratch directory sits in. Coverage is checked target by target,
 * so a delete of two directories needs a grant for each of them, and one grant
 * over the directory holding both is not what was agreed.
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

/** The granted directory as a path to work with, or undefined for a bad entry. */
function grantDirectoryOf(grant: CommandGrant): string | undefined {
  return normalizeGrantDirectory(grant.directory);
}

/** Whether a path is reached from the granted directory without a link. */
function nothingLinksOnTheWayDown(directory: string, path: string): boolean {
  const hazard = linksOnTheWayDown(path, directory);
  return !hazard.link && !hazard.unreadable;
}

/**
 * Whether one grant covers one target of a flagged command.
 *
 * A literal target is covered when it is the granted directory or sits under it:
 * the grant names the directory the delete impacts, so deleting that directory is
 * precisely what the answer was given for. A pattern counts where its literal part
 * sits — `/tmp/*` empties `/tmp`, so a grant has to cover `/tmp`. A target the
 * shell fills in from its first word names no directory at all, and the only thing
 * a grant can check for it is where the command runs.
 */
function targetIsCovered(
  directory: string,
  target: string,
  cwd: string | undefined,
): boolean {
  if (NOT_LITERAL.test(target)) {
    const area = literalTargetDirectory(target, cwd);
    if (!area) return cwd !== undefined && insideDirectory(cwd, directory);
    if (!insideDirectory(area, directory)) return false;
    return area === directory || nothingLinksOnTheWayDown(directory, area);
  }

  const path = target.startsWith("/")
    ? normalizeAbsolutePath(target)
    : cwd
      ? normalizeAbsolutePath(`${cwd}/${target}`)
      : undefined;
  if (!path || !insideDirectory(path, directory)) return false;
  return path === directory || nothingLinksOnTheWayDown(directory, path);
}

/**
 * Whether one grant covers a flagged command on its own. `targets` are the operand
 * words it names, `cwd` the directory that command runs in — for a compound
 * command, the directory its own `cd` put the shell in, not the one the call
 * started in.
 */
export function commandGrantCovers(
  grant: CommandGrant,
  classKey: CommandClassKey,
  targets: readonly string[],
  cwd: string | undefined,
): boolean {
  if (grant.class !== classKey) return false;
  const directory = grantDirectoryOf(grant);
  if (!directory) return false;

  if (targets.length === 0)
    return cwd !== undefined && insideDirectory(cwd, directory);

  return targets.every((target) => targetIsCovered(directory, target, cwd));
}

/**
 * The literal directory a target deletes inside, even when its last words are
 * patterns: `/tmp/*` deletes inside `/tmp`, `build/*` inside `build`. Undefined
 * when the shell fills in the beginning of the path (`$BDIR`, `$(mktemp -d)`),
 * which says nothing about where it deletes.
 */
export function literalTargetDirectory(
  target: string,
  cwd: string | undefined,
): string | undefined {
  const absolute = target.startsWith("/");
  const literal: string[] = [];
  for (const segment of target.split("/")) {
    if (!segment) continue;
    if (NOT_LITERAL.test(segment)) break;
    literal.push(segment);
  }
  if (literal.length === 0) return undefined;

  return absolute
    ? normalizeGrantDirectory(`/${literal.join("/")}`)
    : normalizeGrantDirectory(cwd ? `${cwd}/${literal.join("/")}` : undefined);
}

/**
 * Whether the grants cover a flagged command between them. Every target needs its
 * own cover: a delete of two directories is excused by a grant for each of the
 * directories it impacts, and never by one grant over the directory that happens
 * to hold both.
 */
export function commandGrantsCover(
  grants: readonly CommandGrant[],
  classKey: CommandClassKey,
  targets: readonly string[],
  cwd: string | undefined,
): boolean {
  const directories = grants
    .filter((grant) => grant.class === classKey)
    .map(grantDirectoryOf)
    .filter((directory): directory is string => directory !== undefined);
  if (directories.length === 0) return false;

  if (targets.length === 0)
    return (
      cwd !== undefined && directories.some((d) => insideDirectory(cwd, d))
    );

  return targets.every((target) =>
    directories.some((directory) => targetIsCovered(directory, target, cwd)),
  );
}

/**
 * Whether one existing grant already covers one directory a command impacts.
 * An offer uses it to ask only for the directories that still need an answer, so
 * a second `rm -rf build out` after `build` was granted asks about `out` alone.
 */
export function grantCoversDirectory(
  grant: CommandGrant,
  classKey: CommandClassKey,
  directory: string,
  cwd: string | undefined,
): boolean {
  if (grant.class !== classKey) return false;
  const granted = grantDirectoryOf(grant);
  return granted !== undefined && targetIsCovered(granted, directory, cwd);
}

/**
 * The directories a flagged delete impacts, one per operand, deduplicated.
 *
 * A literal operand names the directory the delete hits, and that is what a grant
 * has to name: `rm -rf scratch` impacts `<cwd>/scratch`, not the directory holding
 * it. A pattern names a set of things inside one directory, so its literal part is
 * what a grant names — `rm -rf scratch/*` is a delete inside `scratch`. A target
 * the shell fills in names nothing, and the only place it can land is the directory
 * the delete runs in. Undefined when an operand cannot be placed at all, because
 * then no directory can be named for it.
 */
export function impactedDirectoriesFor(
  targets: readonly string[],
  cwd: string | undefined,
): string[] | undefined {
  const directories: string[] = [];

  for (const target of targets) {
    let directory: string | undefined;
    if (NOT_LITERAL.test(target)) {
      directory =
        literalTargetDirectory(target, cwd) ?? normalizeGrantDirectory(cwd);
    } else {
      const path = target.startsWith("/")
        ? normalizeAbsolutePath(target)
        : cwd
          ? normalizeAbsolutePath(`${cwd}/${target}`)
          : undefined;
      directory = normalizeGrantDirectory(path);
    }

    if (!directory) return undefined;
    if (!directories.includes(directory)) directories.push(directory);
  }

  return directories.length > 0 ? directories : undefined;
}
