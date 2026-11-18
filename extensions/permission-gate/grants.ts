import {
  builtinClassKey,
  type CommandClassKey,
  type CommandGrant,
  commandClassKey,
  describeCommandClass as describeClass,
  grantOffersForCommand,
  normalizeGrantDirectory,
  patternClassKey,
  RECURSIVE_FORCE_DELETE,
} from "../../src/core/commands";
import { configLoader } from "../../src/shared/config";
import { compileCommandPatterns } from "../../src/shared/matching";

/**
 * Command grants are taken for a class of command and one directory.
 *
 * A dangerous command is flagged by a rule — a built-in matcher or a configured
 * pattern — and the same rule flags the next command of the same shape, so an
 * answer to that prompt has to name the rule rather than the command line that
 * happened to be on screen. And what the user is trusting is a place: the
 * directory a recursive force delete hits, not the tree around it and not the
 * whole machine. A grant is therefore the pair — `builtin:recursive force delete`
 * in `/home/mike/project/build` — and a command is excused only when grants cover
 * its class and every directory its targets impact.
 *
 * A delete that names two directories is answered twice, one grant each; a grant
 * over the directory holding both is not on offer at all.
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

/**
 * Whether a class acts on the directory its grant names, rather than merely
 * running inside it. A recursive force delete is about the directory it deletes;
 * `sudo` is only about where it was run.
 */
export function actsOnTheGrantedDirectory(classKey: CommandClassKey): boolean {
  return classKey === builtinClassKey(RECURSIVE_FORCE_DELETE);
}

/** The preposition that says what a class's directory means. */
function grantPreposition(classKey: CommandClassKey): string {
  return actsOnTheGrantedDirectory(classKey) ? "of" : "under";
}

/** A grant as the prompt and the settings list show it. */
export function describeGrant(grant: CommandGrant): string {
  return `${describeCommandClass(grant.class)} ${grantPreposition(grant.class)} ${describeGrantDirectory(
    grant.directory,
  )}`;
}

/**
 * Several grants as one phrase: each class named once, every directory it was
 * granted for listed. This is what a prompt asks the user to agree to.
 */
export function describeGrants(grants: readonly CommandGrant[]): string {
  const directoriesByClass = new Map<CommandClassKey, string[]>();
  for (const grant of grants) {
    const directory = describeGrantDirectory(grant.directory);
    const directories = directoriesByClass.get(grant.class) ?? [];
    if (!directories.includes(directory)) directories.push(directory);
    directoriesByClass.set(grant.class, directories);
  }

  return [...directoriesByClass.entries()]
    .map(
      ([classKey, directories]) =>
        `${describeCommandClass(classKey)} ${grantPreposition(classKey)} ${directories.join(
          ", ",
        )}`,
    )
    .join("; ");
}

/**
 * What an answer covers, spelled for an option label. Up to three directories are
 * named; past that the label says how many, and the prompt note lists every one of
 * them, so a label is never the only place a directory appears.
 */
export function describeGrantOffer(grants: readonly CommandGrant[]): string {
  if (grants.length <= 3) return describeGrants(grants);

  const [first] = grants;
  const oneClass =
    first !== undefined && grants.every((grant) => grant.class === first.class);
  if (oneClass && first)
    return `${describeCommandClass(first.class)} ${grantPreposition(
      first.class,
    )} ${grants.length} directories`;

  return `${grants.length} grants`;
}

export function isCommandAllowed(command: string): boolean {
  const config = configLoader.getConfig();
  return compileCommandPatterns(config.permissionGate.allowedPatterns).some(
    (pattern) => pattern.test(command),
  );
}

/**
 * The grants to offer for a flagged command: the class it was matched as, one for
 * every directory that command impacts.
 *
 * It is worked out from the flagged element itself — the delete inside
 * `cd /work/build && make && rm -rf out` impacts `/work/build/out`, and that is
 * the only grant that would excuse the command the user is being asked about.
 * Nothing is offered when a directory the command impacts cannot be named, or is
 * the directory the call started in: such a command is allowed once, never granted
 * over the tree around what it deletes. Grants the user already holds are left
 * out, so an ask never repeats an answer that is already on file.
 */
export function grantCandidatesFor(
  classKey: CommandClassKey,
  command: string,
  cwd: string | undefined,
  scratchRoots: readonly string[] = [],
  existingGrants: readonly CommandGrant[] = [],
): CommandGrant[] {
  const directories = grantOffersForCommand({
    command,
    classKey,
    cwd,
    home: process.env.HOME,
    scratchRoots,
    grants: existingGrants,
  });
  if (!directories) return [];
  // A partial answer would leave the command flagged, so a directory that cannot
  // be granted takes the whole offer with it.
  if (directories.some(isGrantTooBroad)) return [];
  return directories.map((directory) => ({ class: classKey, directory }));
}

/**
 * A grant for the whole home directory would cover the user's own work, which is
 * the one thing a working-data grant is never about.
 */
export function isGrantTooBroad(directory: string): boolean {
  const home = process.env.HOME;
  return directory === "/" || (home !== undefined && directory === home);
}

export interface CommandGrantsSaveResult {
  scope: "memory" | "local" | "global";
  /** Where the grants live, or null for the in-memory session scope. */
  path: string | null;
  /** The grants this call wrote; empty when the scope already held them all. */
  added: CommandGrant[];
}

/** Where a grant stored in config actually lives. */
export interface GrantLocation {
  scope: "memory" | "local" | "global";
  /** The file holding it, or null when it is only in the session scope. */
  path: string | null;
}

/** Where two grant entries mean the same thing. */
function isSameGrant(a: CommandGrant, b: CommandGrant): boolean {
  return a.class === b.class && a.directory === b.directory;
}

/**
 * The grants one scope's own raw config holds, ignoring anything in `grants` that
 * is not a grant.
 */
function grantsIn(raw: Record<string, unknown>): CommandGrant[] {
  const permissionGate = (raw.permissionGate ?? {}) as Record<string, unknown>;
  return Array.isArray(permissionGate.grants)
    ? permissionGate.grants.filter(
        (entry): entry is CommandGrant =>
          typeof entry === "object" &&
          entry !== null &&
          typeof (entry as CommandGrant).class === "string" &&
          typeof (entry as CommandGrant).directory === "string",
      )
    : [];
}

/**
 * Add grants to one scope, keeping everything else that scope holds. Every
 * directory a command impacts is a grant of its own, so an answer that covers two
 * directories writes two entries and each stays revocable on its own. The scope's
 * own raw config is read first: saving the resolved config instead would write
 * merged defaults into the file and drop whatever the scope already held outside
 * `permissionGate`.
 */
export async function saveCommandGrants(
  grants: readonly CommandGrant[],
  scope: "memory" | "local" | "global",
): Promise<CommandGrantsSaveResult> {
  const raw = (configLoader.getRawConfig(scope) ?? {}) as Record<
    string,
    unknown
  >;
  const permissionGate = (raw.permissionGate ?? {}) as Record<string, unknown>;
  const existing = grantsIn(raw);
  const added = grants.filter(
    (grant) => !existing.some((entry) => isSameGrant(entry, grant)),
  );

  if (added.length === 0) {
    return { scope, path: configLoader.getScopePath(scope), added };
  }

  await configLoader.save(scope, {
    ...raw,
    permissionGate: {
      ...permissionGate,
      grants: [...existing, ...added],
    },
  });

  return { scope, path: configLoader.getScopePath(scope), added };
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
  const existing = grantsIn(raw);
  const kept = existing.filter((entry) => !isSameGrant(entry, grant));
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
export function findGrantScope(grant: CommandGrant): GrantLocation {
  const normalized = normalizeGrantDirectory(grant.directory);
  const scope = (["local", "global"] as const).find((candidate) => {
    const raw = configLoader.getRawConfig(candidate) as Record<
      string,
      unknown
    > | null;
    return grantsIn(raw ?? {}).some(
      (entry) =>
        entry.class === grant.class &&
        normalizeGrantDirectory(entry.directory) === normalized,
    );
  });
  return {
    scope: scope ?? "memory",
    path: scope ? configLoader.getScopePath(scope) : null,
  };
}
