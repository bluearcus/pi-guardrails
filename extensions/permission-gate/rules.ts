import type { Action, Rule } from "../../src/core";
import type { CommandGrant } from "../../src/core/commands";
import { checkDangerousCommand } from "../../src/core/commands";
import type { DangerousPattern, PatternConfig } from "../../src/shared/config";
import { compileCommandPatterns } from "../../src/shared/matching";

export type PermissionGateMeta = {
  command: string;
  description: string;
  pattern: string;
};

export type PermissionGateRuleOptions = {
  patterns: DangerousPattern[];
  useBuiltinMatchers: boolean;
  /** Recursive deletes confined to these roots are not flagged. */
  scratchDelete?: { enabled?: boolean; roots?: string[] };
  /**
   * Classes the user allowed for one directory. A flagged command a grant covers
   * is not reported at all: that answer was already given.
   */
  grants?: readonly CommandGrant[];
  /** Where the call started. Each command in it is placed from there. */
  cwd?: string;
  /** The user's home directory, so a literal `cd ~/work` can be placed. */
  home?: string;
};

export function createPermissionGateRule({
  patterns,
  useBuiltinMatchers,
  scratchDelete,
  grants,
  cwd,
  home,
}: PermissionGateRuleOptions): Rule<PermissionGateMeta> {
  const compiledPatterns = compileCommandPatterns(patterns);
  const scratchRoots =
    scratchDelete && scratchDelete.enabled !== false
      ? (scratchDelete.roots ?? [])
      : undefined;

  return {
    key: "permission-gate.dangerous-command",
    check(action: Action) {
      if (action.kind !== "command") return { kind: "pass" };

      const match = checkDangerousCommand({
        command: action.command,
        patterns: compiledPatterns,
        useBuiltinMatchers,
        fallbackPatterns: patterns,
        scratchRoots,
        grants,
        cwd,
        home,
      });
      if (!match) return { kind: "pass" };

      return {
        kind: "match",
        reason: match.description,
        metadata: {
          command: action.command,
          description: match.description,
          pattern: match.pattern,
        },
      };
    },
  };
}

export function matchCommandPattern(
  command: string,
  patterns: PatternConfig[],
): PatternConfig | null {
  const compiled = compileCommandPatterns(patterns);
  for (let i = 0; i < compiled.length; i++) {
    if (compiled[i].test(command)) return patterns[i];
  }
  return null;
}

export function matchesAnyCommandPattern(
  command: string,
  patterns: PatternConfig[],
): boolean {
  return matchCommandPattern(command, patterns) !== null;
}

export function formatAutoDenyReason(pattern: PatternConfig): string {
  const description = pattern.description?.trim();
  return description
    ? `Command auto-denied: ${description}`
    : "Command matched auto-deny pattern and was blocked automatically.";
}
