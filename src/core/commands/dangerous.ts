import { type Program, parse, type SimpleCommand } from "@aliou/sh";
import { walkCommands, wordToString } from "../shell/ast";
import {
  builtinClassKey,
  type CommandClassKey,
  type CommandGrant,
  commandClassKey,
  commandGrantCoversAny,
  commonAncestorOf,
  grantDirectoryFor,
  grantTargetsFor,
  insideDirectory,
  normalizeGrantDirectory,
  STRUCTURAL_PATTERN,
} from "./classes";
import {
  absoluteOrUndefined,
  classifyScratchDelete,
  deleteOperands,
  RECURSIVE_FORCE_DELETE,
  resolveScratchRoots,
  type ScratchDeleteScope,
} from "./scratch";
import {
  finalWorkingDirectory,
  type WorkingDirectory,
  workingDirectoriesFor,
} from "./working-directory";

/**
 * Dangerous command matchers for the permission gate.
 *
 * Built-in dangerous patterns are matched structurally via AST parsing.
 * Each matcher receives the parsed command words and returns a description
 * if the command is dangerous, or undefined if not matched.
 */

export type StructuralMatcher = (words: string[]) => string | undefined;

export interface CommandPattern {
  pattern: string;
  description?: string;
  regex?: boolean;
}

export interface CompiledCommandPattern {
  test: (input: string) => boolean;
  source: CommandPattern;
}

export interface DangerousCommandMatch {
  description: string;
  pattern: string;
}
/**
 * What a single command in a program may be excused by: the scratch roots, the
 * user's grants, and where that command itself runs.
 */
interface NodeScope {
  scratch?: ScratchDeleteScope;
  grants?: readonly CommandGrant[];
  cwd: WorkingDirectory;
}

export type { CommandGrant } from "./classes";

/** What a grant offer is being worked out for. */
export interface GrantOfferRequest {
  /** The command the gate flagged. */
  command: string;
  /** The class key of the match, as {@link commandClassKey} reports it. */
  classKey: CommandClassKey;
  /** The directory the call started in. */
  cwd?: string;
  /** The user's home directory, for placing a `cd ~/work`. */
  home?: string;
  /** Configured scratch roots; relative ones are placed per command. */
  scratchRoots?: readonly string[];
}

export interface DangerousCommandCheckOptions {
  command: string;
  patterns: readonly CompiledCommandPattern[];
  useBuiltinMatchers: boolean;
  fallbackPatterns: readonly CommandPattern[];
  /**
   * Directories whose contents count as the agent's working data. A recursive
   * force delete with every target inside one of them is not flagged. Only the
   * structural matchers can grant this: a command that had to be matched as text
   * is not verified well enough to excuse. A relative root names a directory
   * inside the directory the delete itself runs in.
   */
  scratchRoots?: readonly string[];
  /**
   * Classes the user allowed for one directory. A flagged command a grant covers
   * is not reported: the answer was already given, for that class in that place.
   */
  grants?: readonly CommandGrant[];
  /**
   * The directory the call started in. It is the starting point for the
   * directories inside the command, not the directory every command in it runs
   * in: a literal `cd` moves it, and a `cd` whose target the shell fills in loses
   * it for everything after it.
   */
  cwd?: string;
  /**
   * The user's home directory, so a literal `cd ~/work` can be placed. Without
   * it a home-relative target is unknown.
   */
  home?: string;
}

/**
 * Helper to check if any word starts with a given prefix.
 */
function hasArg(words: string[], prefix: string): boolean {
  return words.some((w) => w.startsWith(prefix));
}

/**
 * Helper to check if short options contain specific flags.
 * Handles grouped short options like -rf, -fr, -Rfv, etc.
 */
function hasShortFlag(words: string[], flag: string): boolean {
  return words.some(
    (w) =>
      w === `-${flag}` ||
      (w.startsWith("-") && !w.startsWith("--") && w.includes(flag)),
  );
}

/**
 * Helper to check for long options.
 */
function hasLongOption(words: string[], option: string): boolean {
  return words.some((w) => w === `--${option}`);
}

// =============================================================================
// File/Directory Destruction
// =============================================================================

/**
 * rm -rf, rm -r -f, rm --recursive --force, etc.
 * Catches recursive force delete in any form.
 */
const rmMatcher: StructuralMatcher = (words) => {
  if (words[0] !== "rm") return undefined;

  const hasRecursive =
    hasShortFlag(words, "r") ||
    hasShortFlag(words, "R") ||
    hasLongOption(words, "recursive") ||
    hasLongOption(words, "dir");

  const hasForce = hasShortFlag(words, "f") || hasLongOption(words, "force");

  return hasRecursive && hasForce ? RECURSIVE_FORCE_DELETE : undefined;
};

/**
 * shred - secure file/device overwrite
 */
const shredMatcher: StructuralMatcher = (words) => {
  if (words[0] === "shred") return "secure file overwrite";
  return undefined;
};

// =============================================================================
// Privilege Escalation
// =============================================================================

/**
 * sudo - superuser command
 */
const sudoMatcher: StructuralMatcher = (words) => {
  if (words[0] === "sudo") return "superuser command";
  return undefined;
};

/**
 * doas - privilege escalation (OpenBSD-style sudo alternative)
 */
const doasMatcher: StructuralMatcher = (words) => {
  if (words[0] === "doas") return "privileged command execution";
  return undefined;
};

/**
 * pkexec - PolicyKit privilege escalation
 */
const pkexecMatcher: StructuralMatcher = (words) => {
  if (words[0] === "pkexec") return "privileged command execution";
  return undefined;
};

// =============================================================================
// Disk/Filesystem Operations
// =============================================================================

/**
 * dd of= - disk write operation
 * Any dd command with an output file is potentially dangerous.
 */
const ddMatcher: StructuralMatcher = (words) => {
  if (words[0] !== "dd") return undefined;
  return hasArg(words, "of=") ? "disk write operation" : undefined;
};

/**
 * mkfs, mkfs.* - filesystem format
 */
const mkfsMatcher: StructuralMatcher = (words) => {
  const cmd = words[0];
  if (cmd === "mkfs" || cmd?.startsWith("mkfs.")) return "filesystem format";
  return undefined;
};

/**
 * wipefs - filesystem signature wipe
 */
const wipefsMatcher: StructuralMatcher = (words) => {
  if (words[0] === "wipefs") return "filesystem signature wipe";
  return undefined;
};

/**
 * blkdiscard - block device discard (destroys data)
 */
const blkdiscardMatcher: StructuralMatcher = (words) => {
  if (words[0] === "blkdiscard") return "block device discard";
  return undefined;
};

// =============================================================================
// Disk Partitioning
// =============================================================================

/**
 * fdisk, sfdisk, cfdisk - disk partitioning
 */
const fdiskMatcher: StructuralMatcher = (words) => {
  const cmd = words[0];
  if (cmd === "fdisk" || cmd === "sfdisk" || cmd === "cfdisk") {
    return "disk partitioning";
  }
  return undefined;
};

/**
 * parted, sgdisk - advanced disk partitioning
 */
const partedMatcher: StructuralMatcher = (words) => {
  const cmd = words[0];
  if (cmd === "parted" || cmd === "sgdisk") return "disk partitioning";
  return undefined;
};

// =============================================================================
// Permission Changes
// =============================================================================

/**
 * chmod -R 777, chmod --recursive 777, chmod -R 0777, etc.
 * Insecure recursive world-writable permissions.
 */
const chmodMatcher: StructuralMatcher = (words) => {
  if (words[0] !== "chmod") return undefined;

  const hasRecursive =
    hasShortFlag(words, "R") || hasLongOption(words, "recursive");

  const hasWorldWritable = words.some(
    (w) =>
      w === "777" ||
      w === "0777" ||
      w === "a+rwx" ||
      w === "ugo+rwx" ||
      w === "7777" || // setuid/setgid/sticky + world writable
      w === "1777", // sticky + world writable
  );

  return hasRecursive && hasWorldWritable
    ? "insecure recursive permissions"
    : undefined;
};

/**
 * chown -R, chown --recursive - recursive ownership change
 */
const chownMatcher: StructuralMatcher = (words) => {
  if (words[0] !== "chown") return undefined;

  const hasRecursive =
    hasShortFlag(words, "R") || hasLongOption(words, "recursive");

  return hasRecursive ? "recursive ownership change" : undefined;
};

// =============================================================================
// Container Escape / Dangerous Container Operations
// =============================================================================

/**
 * Docker/Podman dangerous run/create patterns.
 * Flags: --privileged, --pid=host, --network=host, --userns=host,
 *        --uts=host, --ipc=host, -v /:/host, docker socket mounts
 */
const containerMatcher: StructuralMatcher = (words) => {
  const cmd = words[0];
  if (!cmd) return undefined;

  // Match docker or podman commands
  const isDocker = cmd === "docker" || cmd === "podman";
  if (!isDocker) return undefined;

  // Only check run and create commands (not build, pull, etc.)
  const subcommand = words[1];
  if (subcommand !== "run" && subcommand !== "create") return undefined;

  // Check for dangerous flags
  const hasPrivileged = words.some(
    (w) => w === "--privileged" || w.startsWith("--privileged="),
  );

  const hasHostPid = words.some(
    (w) => w === "--pid=host" || w.startsWith("--pid=host"),
  );

  const hasHostNetwork = words.some(
    (w) => w === "--network=host" || w.startsWith("--network=host"),
  );

  const hasHostUsers = words.some(
    (w) => w === "--userns=host" || w.startsWith("--userns=host"),
  );

  const hasHostUts = words.some(
    (w) => w === "--uts=host" || w.startsWith("--uts=host"),
  );

  const hasHostIpc = words.some(
    (w) => w === "--ipc=host" || w.startsWith("--ipc=host"),
  );

  // Check for root filesystem bind mount
  const hasRootMount = words.some(
    (w) =>
      w.startsWith("-v/:") ||
      w.startsWith("-v/=>") ||
      w.startsWith("--volume=/:") ||
      w.startsWith("--mount=type=bind,source=/,"),
  );

  // Check for docker socket mount
  const hasDockerSocket = words.some(
    (w) =>
      w.includes("/var/run/docker.sock") ||
      w.includes("/run/docker.sock") ||
      w.includes("/var/run/podman.sock") ||
      w.includes("/run/podman.sock"),
  );

  if (hasPrivileged) return "container with privileged mode";
  if (hasHostPid) return "container with host PID namespace";
  if (hasHostNetwork) return "container with host network";
  if (hasHostUsers) return "container with host user namespace";
  if (hasHostUts) return "container with host UTS namespace";
  if (hasHostIpc) return "container with host IPC";
  if (hasRootMount) return "container with root filesystem mount";
  if (hasDockerSocket) return "container with docker socket access";

  return undefined;
};

// =============================================================================
// Matcher Registry
// =============================================================================

/**
 * All built-in dangerous command matchers.
 * Order matters - earlier matchers take precedence if multiple match.
 */
export const BUILTIN_MATCHERS: StructuralMatcher[] = [
  // Destruction (highest priority)
  rmMatcher,
  shredMatcher,

  // Privilege escalation
  sudoMatcher,
  doasMatcher,
  pkexecMatcher,

  // Disk/filesystem operations
  ddMatcher,
  mkfsMatcher,
  wipefsMatcher,
  blkdiscardMatcher,
  fdiskMatcher,
  partedMatcher,

  // Permission changes
  chmodMatcher,
  chownMatcher,

  // Container escapes
  containerMatcher,
];

/**
 * Keywords for each built-in matcher, used for documentation/UI.
 * These should match the patterns in DEFAULT_CONFIG in config.ts.
 */
export const BUILTIN_KEYWORD_PATTERNS = new Set([
  "rm -rf",
  "sudo",
  "dd of=",
  "mkfs.",
  "chmod -R 777",
  "chown -R",
  "doas",
  "pkexec",
  "shred",
  "wipefs",
  "blkdiscard",
  "fdisk",
  "parted",
  "docker run --privileged",
]);

/**
 * Match a command against all built-in dangerous patterns.
 * Returns the first match found, or undefined if no match.
 */
export function matchDangerousCommand(
  words: string[],
): DangerousCommandMatch | undefined {
  for (const matcher of BUILTIN_MATCHERS) {
    const description = matcher(words);
    if (description) {
      // Use the command itself as the pattern identifier
      const pattern = words[0] ?? "unknown";
      return { description, pattern };
    }
  }
  return undefined;
}

export function compileCommandPattern(
  config: CommandPattern,
): CompiledCommandPattern {
  if (config.regex) {
    try {
      const re = new RegExp(config.pattern);
      return { test: (input) => re.test(input), source: config };
    } catch {
      return { test: () => false, source: config };
    }
  }

  return {
    test: (input) => input.includes(config.pattern),
    source: config,
  };
}

export function compileCommandPatterns(
  configs: readonly CommandPattern[],
): CompiledCommandPattern[] {
  return configs.map(compileCommandPattern);
}

function matchBuiltinDangerous(
  words: string[],
  scope?: NodeScope,
): DangerousCommandMatch | undefined {
  if (words.length === 0) return undefined;
  for (const matcher of BUILTIN_MATCHERS) {
    const description = matcher(words);
    if (!description) continue;
    if (
      description === RECURSIVE_FORCE_DELETE &&
      scope?.scratch &&
      classifyScratchDelete(words, scope.scratch).confined
    ) {
      // Deleting the agent's own scratch data is ordinary work, not a risk.
      continue;
    }
    const match = { description, pattern: STRUCTURAL_PATTERN };
    if (scope?.grants) {
      const classKey = commandClassKey(match);
      if (
        commandGrantCoversAny(
          scope.grants,
          classKey,
          grantTargetsFor(classKey, words),
          scope.cwd,
        )
      ) {
        continue;
      }
    }
    return match;
  }
  return undefined;
}

/**
 * Where the commands of a parsed program run. The directory is followed through
 * the program rather than discarded as soon as a `cd` appears, because a
 * compound cleanup command names the directory it is working in and that is the
 * directory a grant would have to name.
 */
interface PlacedCommands {
  /** The directory of each command node. Absent means not followed. */
  directories: Map<SimpleCommand, WorkingDirectory>;
  /** Where the program leaves the shell. */
  final: WorkingDirectory;
}

function placeCommands(
  ast: Program,
  cwd: string | undefined,
  home: string | undefined,
): PlacedCommands {
  const start = absoluteOrUndefined(cwd);
  const homeDirectory = absoluteOrUndefined(home);
  const options = { home: homeDirectory };
  return {
    directories: workingDirectoriesFor(ast, start, options),
    final: finalWorkingDirectory(ast, start, options),
  };
}

export function checkDangerousCommand({
  command,
  patterns,
  useBuiltinMatchers,
  fallbackPatterns,
  scratchRoots,
  grants,
  cwd,
  home,
}: DangerousCommandCheckOptions): DangerousCommandMatch | undefined {
  // Recovery returns a best-effort partial AST next to the errors that
  // triggered it. Structural matching on a recovered AST only adds detections;
  // the substring fallbacks still run for every parse that did not come back
  // clean, so a partial AST is never the sole basis for treating a command as
  // safe.
  let parsedCleanly = false;
  let ast: Program | undefined;
  try {
    const result = parse(command, { recoverErrors: true });
    ast = result.ast;
    parsedCleanly = (result.errors?.length ?? 0) === 0;
  } catch {
    ast = undefined;
  }

  // Each command in the program is placed in the directory the shell is in when
  // it runs. Relative targets — the scratch exemption's and a grant's alike —
  // are placed against that. Absolute targets do not depend on it, and a command
  // the gate cannot place is excused by nothing.
  const placed = ast ? placeCommands(ast, cwd, home) : undefined;

  if (useBuiltinMatchers) {
    if (ast && ast.body.length > 0) {
      let match: DangerousCommandMatch | undefined;
      walkCommands(
        ast,
        (cmd) => {
          // Skip compound-node redirect callbacks (cmd === undefined): command
          // matchers match on words, not redirect targets.
          if (!cmd) return false;
          const words = (cmd.words ?? []).map(wordToString);
          const at = placed?.directories.get(cmd);
          const result = matchBuiltinDangerous(words, {
            scratch: scratchRoots
              ? { roots: scratchRoots, cwd: at }
              : undefined,
            grants,
            cwd: at,
          });
          if (result) {
            match = result;
            return true;
          }
          return false;
        },
        { includeSubstitutions: true },
      );
      if (match) return match;
    }
    if (!parsedCleanly) {
      for (const pattern of fallbackPatterns) {
        if (command.includes(pattern.pattern)) {
          return {
            description: pattern.description ?? pattern.pattern,
            pattern: pattern.pattern,
          };
        }
      }
    }
  }

  for (const compiled of patterns) {
    const source = compiled.source;
    if (
      useBuiltinMatchers &&
      parsedCleanly &&
      !source.regex &&
      BUILTIN_KEYWORD_PATTERNS.has(source.pattern)
    ) {
      continue;
    }

    if (compiled.test(command)) {
      const match = {
        description: source.description ?? source.pattern,
        pattern: source.pattern,
      };
      if (
        grants &&
        placed &&
        commandGrantCoversAny(grants, commandClassKey(match), [], placed.final)
      ) {
        continue;
      }
      return match;
    }
  }

  return undefined;
}

/**
 * The directory a prompt may offer a grant for, given the command the gate
 * flagged and the class it flagged it as.
 *
 * The offer is about the flagged element, not about the whole command line: the
 * targets of each recursive force delete in it are placed in the directory that
 * delete itself runs in, which is what a `cd` at the front of a compound command
 * establishes. A grant is standing authority over everything inside a directory,
 * so a directory is only offered when the command was already working in it, or
 * when it sits inside a scratch root the config declares. A delete that climbs
 * out of the directory it runs in would need authority over its parent —
 * everything next to the thing being deleted — so it is allowed once or not at
 * all, never granted.
 */
export function grantOfferForCommand({
  command,
  classKey,
  cwd,
  home,
  scratchRoots = [],
}: GrantOfferRequest): string | undefined {
  let ast: Program | undefined;
  try {
    ast = parse(command, { recoverErrors: true }).ast;
  } catch {
    return undefined;
  }
  if (!ast) return undefined;

  const placed = placeCommands(ast, cwd, home);
  /** Each directory a grant would have to cover, and where that command runs. */
  const required: { directory: string; cwd: WorkingDirectory }[] = [];

  if (classKey === builtinClassKey(RECURSIVE_FORCE_DELETE)) {
    let unnameable = false;
    walkCommands(
      ast,
      (cmd) => {
        if (!cmd) return false;
        const words = (cmd.words ?? []).map(wordToString);
        if (
          matchBuiltinDangerous(words)?.description !== RECURSIVE_FORCE_DELETE
        ) {
          return false;
        }
        const at = placed.directories.get(cmd);
        const directory = grantDirectoryFor(deleteOperands(words), at);
        if (!directory) {
          unnameable = true;
          return true;
        }
        required.push({ directory, cwd: at });
        return false;
      },
      { includeSubstitutions: true },
    );
    if (unnameable || required.length === 0) return undefined;
  } else {
    // A class with no paths of its own is granted where its command runs.
    const directory = normalizeGrantDirectory(placed.final);
    if (!directory) return undefined;
    required.push({ directory, cwd: placed.final });
  }

  const candidate = commonAncestorOf(required.map((entry) => entry.directory));
  if (!candidate) return undefined;

  const offered = required.every((entry) =>
    acceptableOffer(entry, candidate, scratchRoots),
  );

  return offered ? candidate : undefined;
}

function acceptableOffer(
  entry: { directory: string; cwd: WorkingDirectory },
  candidate: string,
  scratchRoots: readonly string[],
): boolean {
  if (entry.cwd && insideDirectory(candidate, entry.cwd)) return true;
  const scratch = resolveScratchRoots(scratchRoots, entry.cwd);
  return scratch.some(
    (root) =>
      insideDirectory(candidate, root) &&
      insideDirectory(entry.directory, root),
  );
}
