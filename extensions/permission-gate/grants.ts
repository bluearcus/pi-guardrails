import {
  type CommandClassKey,
  type CommandGrant,
  commandClassKey,
  describeCommandClass as describeClass,
  grantOfferForCommand,
  normalizeGrantDirectory,
  patternClassKey,
} from "../../src/core/commands";
import { configLoader } from "../../src/shared/config";
import { compileCommandPatterns } from "../../src/shared/matching";

/**
 * Command grants are taken for a class of command in a directory.
 *
 * A dangerous command is flagged by a rule — a built-in matcher or a configured
 * pattern — and the same rule flags the next command of the same shape, so an
 * answer to that prompt has to name the rule rather than the command line that
 * happened to be on screen. And what the user is trusting is a place: recursive
 * force delete for the directory the task is happening in, not for the whole
 * machine. A grant is therefore the pair — `builtin:recursive force delete` in
 * `/home/mike/project` — and a command is excused only when the grant covers
 * both its class and where its targets are.
 *
 * Grants live in config (`permissionGate.grants`), so a session grant and a
 * permanent grant are the same entry in a different scope: memory resets on
 * reload, local and global do not.
 */

export type { CommandClassKey, CommandGrant };
export { commandClassKey, patternClassKey };

/** Where a grant applies, spelled for a prompt or a settings list. */
export function describeGrantDirectory(directory: string): string {
  const home = process.env.HOME;
  if (home && (directory === home || directory.startsWith(`${home}/`))) {
    return `~${directory.slice(home.length)}`;
  }
  return directory;
}

/** What a class is called, without its `builtin:` or `pattern:` prefix. */
export function describeCommandClass(classKey: CommandClassKey): string {
  return describeClass(classKey);
}

/** A grant as the prompt and the settings list show it. */
export function describeGrant(grant: CommandGrant): string {
  return `${describeCommandClass(grant.class)} under ${describeGrantDirectory(
    grant.directory,
  )}`;
}

export function isCommandAllowed(command: string): boolean {
  const config = configLoader.getConfig();
  return compileCommandPatterns(config.permissionGate.allowedPatterns).some(
    (pattern) => pattern.test(command),
  );
}

/**
 * The grant to offer for a flagged command: the class it was matched as, in the
 * one directory that would cover it.
 *
 * It is worked out from the flagged element itself — the delete inside
 * `cd /work/build && make && rm -rf $BDIR`, in the directory that `cd` put the
 * shell in — because that is the only grant that would excuse the command the
 * user is being asked about. Undefined when no directory the command was already
 * working in would cover it: a delete of something outside its own directory is
 * allowed once, not granted over the tree around it.
 */
export function grantCandidateFor(
  classKey: CommandClassKey,
  command: string,
  cwd: string | undefined,
  scratchRoots: readonly string[] = [],
): CommandGrant | undefined {
  const directory = grantOfferForCommand({
    command,
    classKey,
    cwd,
    home: process.env.HOME,
    scratchRoots,
  });
  if (!directory) return undefined;
  if (isGrantTooBroad(directory)) return undefined;
  return { class: classKey, directory };
}

/**
 * A grant for the whole home directory would cover the user's own work, which is
 * the one thing a working-data grant is never about.
 */
export function isGrantTooBroad(directory: string): boolean {
  const home = process.env.HOME;
  return directory === "/" || (home !== undefined && directory === home);
}

export interface CommandGrantSaveResult {
  scope: "memory" | "local" | "global";
  /** Where the grant lives, or null for the in-memory session scope. */
  path: string | null;
  /** False when that grant was already in the scope. */
  added: boolean;
}

/**
 * Add a grant to one scope, keeping everything else that scope holds. The
 * scope's own raw config is read first: saving the resolved config instead would
 * write merged defaults into the file and drop whatever the scope already held
 * outside `permissionGate`.
 */
export async function saveCommandGrant(
  grant: CommandGrant,
  scope: "memory" | "local" | "global",
): Promise<CommandGrantSaveResult> {
  const raw = (configLoader.getRawConfig(scope) ?? {}) as Record<
    string,
    unknown
  >;
  const permissionGate = (raw.permissionGate ?? {}) as Record<string, unknown>;
  const existing = Array.isArray(permissionGate.grants)
    ? permissionGate.grants.filter(
        (entry): entry is CommandGrant =>
          typeof entry === "object" &&
          entry !== null &&
          typeof (entry as CommandGrant).class === "string" &&
          typeof (entry as CommandGrant).directory === "string",
      )
    : [];

  if (
    existing.some(
      (entry) =>
        entry.class === grant.class && entry.directory === grant.directory,
    )
  ) {
    return { scope, path: configLoader.getScopePath(scope), added: false };
  }

  await configLoader.save(scope, {
    ...raw,
    permissionGate: {
      ...permissionGate,
      grants: [...existing, grant],
    },
  });

  return { scope, path: configLoader.getScopePath(scope), added: true };
}

/** Remove one grant from a scope's own config, leaving the rest of it alone. */
export async function removeCommandGrant(
  grant: CommandGrant,
  scope: "memory" | "local" | "global",
): Promise<boolean> {
  const raw = (configLoader.getRawConfig(scope) ?? {}) as Record<
    string,
    unknown
  >;
  const permissionGate = (raw.permissionGate ?? {}) as Record<string, unknown>;
  const existing = Array.isArray(permissionGate.grants)
    ? permissionGate.grants.filter(
        (entry): entry is CommandGrant =>
          typeof entry === "object" &&
          entry !== null &&
          typeof (entry as CommandGrant).class === "string" &&
          typeof (entry as CommandGrant).directory === "string",
      )
    : [];
  const kept = existing.filter(
    (entry) =>
      entry.class !== grant.class || entry.directory !== grant.directory,
  );
  if (kept.length === existing.length) return false;

  await configLoader.save(scope, {
    ...raw,
    permissionGate: { ...permissionGate, grants: kept },
  });
  return true;
}

/**
 * Where a grant stored in config actually lives. A grant can be in any scope, so
 * revoking one means finding the scope that holds it, global last because it is
 * the broadest reach.
 */
export function findGrantScope(grant: CommandGrant): CommandGrantSaveResult {
  const normalized = normalizeGrantDirectory(grant.directory);
  const scope = (["local", "global"] as const).find((candidate) => {
    const raw = configLoader.getRawConfig(candidate) as {
      permissionGate?: { grants?: unknown };
    } | null;
    const entries = Array.isArray(raw?.permissionGate?.grants)
      ? raw.permissionGate.grants
      : [];
    return entries.some(
      (entry) =>
        typeof entry === "object" &&
        entry !== null &&
        (entry as CommandGrant).class === grant.class &&
        normalizeGrantDirectory((entry as CommandGrant).directory) ===
          normalized,
    );
  });
  return {
    scope: scope ?? "memory",
    path: scope ? configLoader.getScopePath(scope) : null,
    added: false,
  };
}
