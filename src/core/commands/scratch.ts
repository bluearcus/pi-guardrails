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
 * stay flagged.
 */

export interface ScratchDeleteScope {
  /** Absolute directories whose contents count as the agent's working data. */
  roots: readonly string[];
}

export type ScratchDeleteVerdict =
  | { confined: true }
  | { confined: false; reason: string };

/** Anything the shell expands, or a path that is not written out literally. */
const NOT_LITERAL = /[$*?[\]{}~`\\]/;

/** The description the rm matcher produces. */
export const RECURSIVE_FORCE_DELETE = "recursive force delete";

/** Lexical absolute path resolution: `.` and `..` resolved without touching disk. */
function normalizeAbsolutePath(path: string): string | undefined {
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

/** A usable scratch root: absolute, not the filesystem root. */
export function normalizeScratchRoots(roots: readonly string[]): string[] {
  const normalized: string[] = [];
  for (const root of roots) {
    const path = normalizeAbsolutePath(
      typeof root === "string" ? root.trim() : "",
    );
    if (!path || path === "/") continue;
    if (!normalized.includes(path)) normalized.push(path);
  }
  return normalized;
}

/**
 * Whether a path passes through a symlink on the way down from the scratch
 * root. `rm` resolves intermediate links, so one hop out of the scratch root
 * puts the delete somewhere the exemption was never about. The target itself is
 * not a problem: `rm` unlinks a symlinked operand instead of emptying what it
 * points at.
 */
function linksOnTheWayDown(
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
 * Classify one command's delete targets. `words` is the parsed command, so
 * `rm -rf /tmp/b1` arrives as ["rm", "-rf", "/tmp/b1"].
 */
export function classifyScratchDelete(
  words: readonly string[],
  scope: ScratchDeleteScope,
): ScratchDeleteVerdict {
  const roots = normalizeScratchRoots(scope.roots);
  if (roots.length === 0) {
    return { confined: false, reason: "no scratch root is configured" };
  }

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
    if (!operand.startsWith("/")) {
      return {
        confined: false,
        reason: `${operand} is relative to a working directory outside the scratch root`,
      };
    }
    if (operand.endsWith("/")) {
      return {
        confined: false,
        reason: `${operand} ends with a slash, which makes rm follow a symlinked directory`,
      };
    }

    const path = normalizeAbsolutePath(operand);
    if (!path) {
      return {
        confined: false,
        reason: `${operand} climbs out of the filesystem root`,
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
