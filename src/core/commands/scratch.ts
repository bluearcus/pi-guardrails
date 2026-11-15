import { lstatSync } from "node:fs";

/**
 * Confinement check for recursive force delete.
 *
 * Recursive force delete is the guardrail's most frequent trigger, and most of
 * the time it targets a scratch directory the agent made for the current task
 * under a scratch root such as /tmp. Deleting that is ordinary work: the state
 * can be rebuilt, and nothing the user wrote is in it. What is not ordinary is
 * a delete that reaches outside the scratch root — through a link, a wildcard,
 * a variable, or a path that climbs out — so those are refused exemption and
 * stay flagged. A target written relative to the working directory is placed
 * there before that question is asked: `build` run from `/tmp/work` is
 * `/tmp/work/build`, the same directory however it was spelled.
 */

export interface ScratchDeleteScope {
  /**
   * Directories whose contents count as the agent's working data. An absolute
   * entry is a directory on its own; a relative entry names one inside `cwd`,
   * so a project can declare its own build or scratch subtree.
   */
  roots: readonly string[];
  /**
   * The directory the command runs in. Relative targets are placed against it.
   * Without it a relative target cannot be placed and is refused.
   */
  cwd?: string;
}

export type ScratchDeleteVerdict =
  | { confined: true }
  | { confined: false; reason: string };

/** Anything the shell expands, or a path that is not written out literally. */
export const NOT_LITERAL = /[$*?[\]{}~`\\]/;

/** The description the rm matcher produces. */
export const RECURSIVE_FORCE_DELETE = "recursive force delete";

/** Lexical absolute path resolution: `.` and `..` resolved without touching disk. */
export function normalizeAbsolutePath(path: string): string | undefined {
  if (!path.startsWith("/")) return undefined;
  const parts: string[] = [];
  for (const segment of path.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (parts.length === 0) return undefined;
      parts.pop();
      continue;
    }
    parts.push(segment);
  }
  return `/${parts.join("/")}`;
}

/**
 * The scratch roots as written: absolute entries normalized, relative entries
 * kept as written because they are placed against the working directory only
 * when a command is checked.
 */
export function normalizeScratchRoots(roots: readonly string[]): string[] {
  const normalized: string[] = [];
  for (const root of roots) {
    const raw = typeof root === "string" ? root.trim() : "";
    if (!raw) continue;
    if (raw.startsWith("/")) {
      const path = normalizeAbsolutePath(raw);
      if (!path || path === "/") continue;
      if (!normalized.includes(path)) normalized.push(path);
      continue;
    }
    const relative = raw.replace(/\/+$/, "");
    if (!relative) continue;
    if (!normalized.includes(relative)) normalized.push(relative);
  }
  return normalized;
}

/** An absolute path to work with, or undefined for anything that is not one. */
export function absoluteOrUndefined(path: unknown): string | undefined {
  return typeof path === "string" && path.startsWith("/")
    ? normalizeAbsolutePath(path)
    : undefined;
}

/** Roots as absolute directories, relative ones placed against `cwd`. */
export function resolveScratchRoots(
  roots: readonly string[],
  cwd: string | undefined,
): string[] {
  const resolved: string[] = [];
  for (const root of normalizeScratchRoots(roots)) {
    const path = root.startsWith("/")
      ? root
      : cwd
        ? normalizeAbsolutePath(`${cwd}/${root}`)
        : undefined;
    if (!path || path === "/") continue;
    if (!resolved.includes(path)) resolved.push(path);
  }
  return resolved;
}

/**
 * Whether a path passes through a symlink on the way down from the scratch
 * root. `rm` resolves intermediate links, so one hop out of the scratch root
 * puts the delete somewhere the exemption was never about. The target itself is
 * not a problem: `rm` unlinks a symlinked operand instead of emptying what it
 * points at.
 */
export function linksOnTheWayDown(
  candidate: string,
  root: string,
): { link?: string; unreadable?: string } {
  const segments = candidate.slice(root.length + 1).split("/");
  segments.pop();
  let path = root;
  for (const segment of segments) {
    path = `${path}/${segment}`;
    try {
      if (lstatSync(path).isSymbolicLink()) return { link: path };
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") {
        // Nothing exists below here, so nothing links out of it either.
        break;
      }
      return { unreadable: path };
    }
  }
  return {};
}

/**
 * The target operands of a command, its arguments with the flags removed:
 * `rm -rf /tmp/b1 -- force` gives ["/tmp/b1", "force"].
 */
export function deleteOperands(words: readonly string[]): string[] {
  const operands: string[] = [];
  let afterSeparator = false;
  for (const word of words.slice(1)) {
    if (!word) continue;
    if (!afterSeparator && word === "--") {
      afterSeparator = true;
      continue;
    }
    if (!afterSeparator && word.startsWith("-")) continue;
    operands.push(word);
  }
  return operands;
}

/**
 * Classify one command's delete targets. `words` is the parsed command, so
 * `rm -rf /tmp/b1` arrives as ["rm", "-rf", "/tmp/b1"]. A relative target is
 * placed against `scope.cwd`, which is why the caller has to supply it.
 */
export function classifyScratchDelete(
  words: readonly string[],
  scope: ScratchDeleteScope,
): ScratchDeleteVerdict {
  const cwd = absoluteOrUndefined(scope.cwd);
  const roots = resolveScratchRoots(scope.roots, cwd);
  if (roots.length === 0) {
    return { confined: false, reason: "no scratch root is configured" };
  }

  const operands = deleteOperands(words);

  if (operands.length === 0) {
    return { confined: false, reason: "the delete names no target" };
  }

  for (const operand of operands) {
    if (NOT_LITERAL.test(operand)) {
      return {
        confined: false,
        reason: `${operand} is not a literal path`,
      };
    }
    // A trailing slash is spelling, not another directory: /tmp/build/ is
    // /tmp/build. What rm can follow is a link it walks into, and
    // linksOnTheWayDown checks that walk below the scratch root.
    const target = operand.replace(/\/+$/, "");
    if (target === "") {
      return {
        confined: false,
        reason: `${operand} is the filesystem root, not the agent's own directory`,
      };
    }

    const path = target.startsWith("/")
      ? normalizeAbsolutePath(target)
      : cwd
        ? normalizeAbsolutePath(`${cwd}/${target}`)
        : undefined;
    if (!path) {
      return {
        confined: false,
        reason: `${operand} is relative to a working directory the gate cannot place it in`,
      };
    }

    const root = roots.find(
      (candidate) => path === candidate || path.startsWith(`${candidate}/`),
    );
    if (!root) {
      return {
        confined: false,
        reason: `${operand} is outside the scratch roots (${roots.join(", ")})`,
      };
    }
    if (path === root) {
      return {
        confined: false,
        reason: `${operand} is the whole scratch root, not the agent's own directory`,
      };
    }

    const hazard = linksOnTheWayDown(path, root);
    if (hazard.link) {
      return {
        confined: false,
        reason: `${operand} reaches its target through the symlink ${hazard.link}`,
      };
    }
    if (hazard.unreadable) {
      return {
        confined: false,
        reason: `${hazard.unreadable} cannot be read to rule out a symlink`,
      };
    }
  }

  return { confined: true };
}
