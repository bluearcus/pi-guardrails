import {
  type DangerousCommandMatch,
  STRUCTURAL_PATTERN,
} from "../../src/core/commands";
import { configLoader } from "../../src/shared/config";
import { compileCommandPatterns } from "../../src/shared/matching";

/**
 * Command grants are taken for a class, not for one command string.
 *
 * A dangerous command is flagged by a rule — a built-in matcher or a
 * configured pattern — and the same rule flags the next command of the same
 * shape. An answer to that prompt is only worth anything if it carries over to
 * the rule, so a grant names the rule rather than the command that happened to
 * be on screen: `builtin:<description>` for a built-in matcher, `pattern:<pattern>`
 * for a configured pattern.
 *
 * Grants live in config (`permissionGate.allowedClasses`), so a session grant
 * and a permanent grant are the same entry in a different scope: memory resets
 * on reload, local and global do not.
 */
export type CommandClassKey = string;

export const BUILTIN_CLASS_PREFIX = "builtin:";
export const PATTERN_CLASS_PREFIX = "pattern:";

/** The class a flagged command was matched as. */
export function commandClassKey(match: DangerousCommandMatch): CommandClassKey {
  return match.pattern === STRUCTURAL_PATTERN
    ? `${BUILTIN_CLASS_PREFIX}${match.description}`
    : `${PATTERN_CLASS_PREFIX}${match.pattern}`;
}

/** What a class is called in a prompt or in settings. */
export function describeCommandClass(key: CommandClassKey): string {
  for (const prefix of [BUILTIN_CLASS_PREFIX, PATTERN_CLASS_PREFIX]) {
    if (key.startsWith(prefix)) return key.slice(prefix.length);
  }
  return key;
}

export function isCommandAllowed(command: string): boolean {
  const config = configLoader.getConfig();
  return compileCommandPatterns(config.permissionGate.allowedPatterns).some(
    (pattern) => pattern.test(command),
  );
}

/** Whether this class of command has already been allowed. */
export function isCommandClassAllowed(key: CommandClassKey): boolean {
  return configLoader.getConfig().permissionGate.allowedClasses.includes(key);
}

export interface CommandGrantSaveResult {
  scope: "memory" | "local" | "global";
  /** Where the grant lives, or null for the in-memory session scope. */
  path: string | null;
  /** False when the class was already granted in that scope. */
  added: boolean;
}

/**
 * Add a class grant to one scope, keeping everything else that scope holds.
 * The scope's own raw config is read first: saving the resolved config instead
 * would write merged defaults into the file and drop whatever the scope already
 * held outside `permissionGate`.
 */
export async function saveCommandGrant(
  key: CommandClassKey,
  scope: "memory" | "local" | "global",
): Promise<CommandGrantSaveResult> {
  const raw = (configLoader.getRawConfig(scope) ?? {}) as Record<
    string,
    unknown
  >;
  const permissionGate = (raw.permissionGate ?? {}) as Record<string, unknown>;
  const existing = Array.isArray(permissionGate.allowedClasses)
    ? permissionGate.allowedClasses.filter(
        (entry): entry is string =>
          typeof entry === "string" && entry.trim() !== "",
      )
    : [];

  if (existing.includes(key)) {
    return { scope, path: configLoader.getScopePath(scope), added: false };
  }

  await configLoader.save(scope, {
    ...raw,
    permissionGate: {
      ...permissionGate,
      allowedClasses: [...existing, key],
    },
  });

  return { scope, path: configLoader.getScopePath(scope), added: true };
}
