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
- A recursive force delete whose every target sits inside `permissionGate.scratchDelete.roots` (default `/tmp`) is not flagged: that is the agent's own working data. The check is `src/core/commands/scratch.ts` and it applies only inside the built-in structural matcher loop — never to text fallback matching or to user-configured patterns — and it refuses relative targets, wildcards and variables, the scratch root itself, and paths through a symlink. Keep `scratchScope` threaded from `createPermissionGateRule` into `checkDangerousCommand`.

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
