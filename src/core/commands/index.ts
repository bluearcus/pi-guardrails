export type {
  CommandPattern,
  CompiledCommandPattern,
  DangerousCommandCheckOptions,
  DangerousCommandMatch,
  StructuralMatcher,
} from "./dangerous";
export {
  BUILTIN_KEYWORD_PATTERNS,
  BUILTIN_MATCHERS,
  checkDangerousCommand,
  compileCommandPattern,
  compileCommandPatterns,
  matchDangerousCommand,
} from "./dangerous";
export type { ScratchDeleteScope, ScratchDeleteVerdict } from "./scratch";
export {
  classifyScratchDelete,
  normalizeScratchRoots,
  RECURSIVE_FORCE_DELETE,
} from "./scratch";
