# pi-guardrails

Public Pi extension package providing security hooks for Pi: file protection policies, workspace path access control, dangerous-command confirmation, a model-backed decision delegate (Pi classifier models or cloud chat models), and a Herdr prompt adapter. People depend on this, so treat the public API as backwards-compatibility-sensitive.

Pi is pre-1.0.0, so breaking changes can happen between Pi versions. This extension must stay up to date with Pi or things will break.

## Commands

Uses pnpm. Package scripts are discoverable in `package.json`. In git worktrees, `.pre-commit-config.yaml` (a gitignored symlink created by the Nix dev shell) is missing, so commits there need `PRE_COMMIT_ALLOW_NO_CONFIG=1`.

## Conventions

- Built-in dangerous command matching uses AST parsing via `@aliou/sh`; user-configured patterns use substring/regex matching. Do not switch built-ins to pattern matching.
- File protection is policy-based (`features.policies`, `policies.rules`), not the legacy `envFiles` shape.
- Config migrations are predicate-based (`shouldRun`) using structural checks; never compare version strings lexically.
- Runtime code handles only current config/core shapes. Old shapes belong exclusively in migrations; do not add runtime compatibility branches for legacy config.
- `config.version` is a schema marker for debugging/inspection, not the package version.
- Events emitted on the Pi event bus for inter-extension communication are defined in `src/shared/events.ts`. Keep the public event contract backwards-compatible; `guardrails:action:prompted` exists only as a deprecated alias of `guardrails:prompt:opened`.
- Decision delegates run before every fallback that needs no input: in permission-gate and path-access, `delegateDecision()` sits between the deterministic checks and both the confirm prompt and the no-UI block, so headless sessions get the same allow or block. `describeReview()` in `src/shared/delegation` renders the delegates' reasoning wherever an escalated action surfaces — prompts, select fallbacks, headless block reasons.
- A permission-gate grant pairs the class that was flagged with **one
  directory**: `permissionGate.grants` holds `{ class, directory }`, where
  `class` is `builtin:<matcher description>` or `pattern:<pattern>`
  (`commandClassKey()` in `src/core/commands/classes.ts` derives it from the
  match) and `directory` is absolute, never `/` or the home directory. For a
  recursive delete that directory is **the directory the delete impacts** —
  `rm -rf scratch` is a grant for `<cwd>/scratch`, not for the tree holding it.
  Coverage is decided in core: `checkDangerousCommand` takes `grants` and `cwd`
  and drops a match the grants cover, so a covered command never produces a risk
  event, a prompt, or a delegate review — do not re-parse the command in the
  extension to decide coverage. A delete is covered only when every target is a
  granted directory or sits under it, and a delete of several directories is
  covered only when each of them has its own grant (`commandGrantsCover()`);
  a wildcard target counts where its literal part sits (`/tmp/*` deletes inside
  `/tmp`, `literalTargetDirectory()`); a target the shell fills in from its first
  word, and any class with no path targets, only where that command ran.
- Every command in a program is placed in the directory the shell is in when it
  runs: `workingDirectoriesFor()` in `src/core/commands/working-directory.ts`
  follows the program in order. A literal `cd` or `pushd` moves the directory;
  a `cd` whose target the shell fills in, `cd` with no target, `cd -` and `popd`
  lose it; a subshell, a pipeline element and a command substitution are scoped
  so a move inside them says nothing outside; a loop, `if` or `case` body places
  the commands inside it and loses the directory afterwards because the body may
  not run, or may run twice; a function definition whose body moves the
  directory loses it until a literal `cd` says where the shell is. Coverage, the
  scratch exemption and the grant offer are all decided against that directory,
  so `cd build && rm -rf out` is placed in `build` and not in the directory the
  call started in — a compound cleanup command is the normal shape of these
  prompts, and the flagged delete has to be grantable where it actually runs.
  A command inside a command substitution is not placed at all (which of the
  enclosing commands carried it is not worth a parent chain), so it is excused
  by nothing. Every target of a spanning delete needs a grant of its own. What
  the prompt may *offer* is narrower than what a grant can cover:
  `grantOffersForCommand()` returns every directory the flagged deletes of that
  class impact — each one a separate ask, and only where the delete was already
  working in it or it sits inside a declared scratch root, never the directory
  the call started in, because that grant would be the whole project. A delete
  whose target the shell fills in names no directory below the one it started in,
  so it is offered nothing. A directory an existing grant of that class already
  covers is left out of the offer (`grantCoversDirectory()`), so a repeated
  delete asks only for what is still unanswered for. A hand-written
  `permissionGate.grants` entry is
  coverage as stated, so keeping an offer honest is the extension's job, not the
  checker's. `saveCommandGrants()` merges into the target scope's own raw config
  because `ConfigLoader.save()` replaces a scope wholesale, which would otherwise
  drop everything else that scope held.
- The permission-gate prompt answers **one directory at a time**. Its component
  resolves with a `PermissionGateDecision`: an outcome for the command
  (`allow` / `deny` / `stop`) plus an answer per impacted directory — `session`,
  `always`, `once` (allowed now, no standing grant) or `refuse`. With more than
  one directory the option list adds `c`, which opens a picker where `a`/`A`/`y`/`n`
  answer the highlighted directory and `Tab` cycles it; with no custom component
  the same answers are a sequence of selects, one per directory. A command is
  atomic, so one refusal sets the outcome to `deny`, while the grants chosen for
  the other directories are still saved — an answer for `build` is an answer for
  `build` whatever happened to `out`. Keep that split: the decision is per
  directory, the run is per command. Extension tests drive the real component
  through `tests/utils/prompt-answers.ts` (`answerPrompt("deny")`,
  `pressKeys(["c", "a", "n", "\r"])`) instead of stubbing a result, so a test
  cannot claim an answer the prompt would not produce.
- A recursive force delete whose every target sits inside `permissionGate.scratchDelete.roots` (default `/tmp`) is not flagged: that is the agent's own working data. The check is `src/core/commands/scratch.ts` and it applies only inside the built-in structural matcher loop — never to text fallback matching or to user-configured patterns — and it refuses wildcard and variable targets, the scratch root itself, paths through a symlink, and a relative target it cannot place: the command moved the directory with something it cannot resolve (`cd $WORK`, `cd -`, `popd`), or the delete sits in a body it cannot follow. Keep `scratchRoots` threaded from `createPermissionGateRule` into `checkDangerousCommand`, and place each delete in the directory that delete itself runs in (`workingDirectoriesFor()`) rather than the one the tool call started in.

## Documentation triggers

- Adding, updating, or removing default policy rules, default permission gate patterns, or example presets: `src/shared/config/defaults.ts` and `extensions/guardrails/commands/settings/examples.ts` are the source of truth. Update `schema.json` with `pnpm gen:schema` if config types changed.
- Update `README.md` when public behavior, commands, or the discovery flow change.
- Read and update `docs/decision-delegation.md` when changing what reaches delegates, the delegate contract, or the reviewer (classifier or chat path).
- Run `pnpm changeset` before committing user-facing changes: `patch` for bug fixes, `minor` for new features/hooks, `major` for breaking changes.

## Fork

This checkout is a fork. `origin` is the fork, `upstream` is `aliou/pi-guardrails`.

- `pnpm upstream:check` (or `scripts/upstream-check.sh`) reports upstream commits this fork has not merged, and exits nonzero when there are any.
- `tools/upstream-watch.ts` is a personal Pi extension that runs the same check at session start and adds `/upstream`. It is not part of the package manifest, so package users never load it.
- The workflows `publish.yml`, `check-release.yml` and `upstream-sync.yml` are deleted here: the first two delegate to `aliou/actions` reusable workflows and their secrets, so they cannot work on a fork, and the third notified through an issue while forks have Issues off. A merge from upstream restores them — re-check `.github/workflows/` after merging.
