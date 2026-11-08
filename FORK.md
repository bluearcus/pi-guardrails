# Fork notes

This is a fork of [aliou/pi-guardrails](https://github.com/aliou/pi-guardrails).

What this fork adds: the decision delegate accepts **cloud chat models**, not
only Pi classifier models. `classifier.models` takes any `provider/model` — a
catalogue classifier keeps Pi's `classify()` API, anything else is asked the
same rubric as a chat model and answers JSON. See
[docs/decision-delegation.md](docs/decision-delegation.md#built-in-model-reviewer).

Fork default: `classifier.models` is `opencode-go/deepseek-v4.1-flash` rather
than upstream's `typesafe/jev-latest` (`src/shared/config/defaults.ts`). The
reviewer itself stays off until `features.classifier` is enabled.

Fork behavior change: upstream blocks a flagged command in print/JSON mode
before consulting delegates. Here delegates are consulted first in both
permission-gate and path-access, so a headless session can get a reviewed allow
or block. When merging upstream, keep `delegateDecision()` ahead of the
`!ctx.hasUI` branch and `PathAccessState.canDelegate` ahead of the core's
no-UI denial.

Fork behavior change: a recursive force delete whose every target sits inside an
agent scratch root (`permissionGate.scratchDelete.roots`, default `/tmp`) is not
flagged at all, because that is the agent's own working data. The exemption is
structural — `src/core/commands/scratch.ts` — and is refused for a target that
is relative, a wildcard or variable, the whole scratch root, or a path through a
symlink, and for any command that had to be matched as text. Upstream flags
every `rm -rf`. When merging upstream, keep `scratchScope` threaded from
`createPermissionGateRule` into `checkDangerousCommand` and the exemption inside
the built-in matcher loop only.

## Remotes

```text
origin    your fork        (push here)
upstream  aliou/pi-guardrails (fetch only)
```

If a clone does not have them yet:

```sh
git remote add upstream https://github.com/aliou/pi-guardrails
git config fork.upstream-branch main
```

## Creating the fork

```sh
gh repo fork aliou/pi-guardrails --remote --remote-name upstream
# or: fork on the web, then
git remote rename origin upstream
git remote add origin git@github.com:<your-username>/pi-guardrails.git
git push -u origin main
```

## Running the fork in Pi

From git, which Pi re-fetches at each start or `/reload`:

```sh
pi install git:github.com/<your-username>/pi-guardrails@main
```

Or publish under your own npm scope: change `name` (and `repository`) in
`package.json`, `npm publish`, then `pi install npm:<scope>/pi-guardrails`.
Keep the `pi.extensions` manifest paths intact.

## Knowing when upstream moved

Two paths, both local:

1. **On demand** — `pnpm upstream:check`. Prints the unmerged upstream
   commits and exits nonzero when there are any, so it composes in scripts:
   `pnpm upstream:check || echo "merge upstream before shipping"`.
2. **Inside Pi** — `tools/upstream-watch.ts` runs that check at session start and
   adds an `/upstream` command:

   ```sh
   pi install <repo>/tools/upstream-watch.ts
   ```

   ```json
   // ~/.pi/agent/upstream-watch.json
   {
     "repos": ["/home/mike/Sync/Projects/PiCodingHarness/pi-guardrails"]
   }
   ```

## Workflows

| workflow | state |
|---|---|
| `ci.yml` | upstream's, kept — runs typecheck, tests, lint, schema freshness on every push and PR |
| `upstream-sync.yml` | **removed** — it notified by opening an issue, and forks have Issues off; the Pi-side watcher and `pnpm upstream:check` cover the same ground |
| `publish.yml` | **removed** — it delegates to `aliou/actions/.github/workflows/publish.yml` with aliou's secrets and would publish `@aliou/pi-guardrails` to npm. On a fork it failed after every CI run |
| `check-release.yml` | **removed** — upstream's npm release checker, also a `aliou/actions` reusable workflow |

Merging upstream restores the three removed files unless you drop them again:
check `.github/workflows/` after every merge.

## Merging upstream

Do not `git merge upstream/main` while upstream's classifier deletion is unmerged: a merge
currently conflicts on 17 paths, four of them `modify/delete` in `extensions/classifier/`, which is
where this fork's chat reviewer lives and what `features.classifier` runs. Bring fixes down one
commit at a time instead, as below.

```sh
pnpm upstream:check          # what is coming
git fetch upstream
git merge upstream/main      # conflicts: resolve, keeping the fork's changes
pnpm install                 # lockfile changes need reconciling
pnpm typecheck && pnpm test && pnpm lint
pnpm check:schema            # regenerate if config types changed: pnpm gen:schema
pnpm changeset               # describe the merge if it changes behaviour
```

### What has been taken, and what has been refused

Taken by cherry-pick, with `@aliou/sh` moved to `^0.4.1`:

| upstream | fix |
|---|---|
| `fd711a6` | `AnsiC`/`LocaleStr` word parts and structured heredoc bodies are parsed and walked, and `partToString` throws on a part type it does not handle |
| `d5ca339` | dangerous-command matching runs on recovered (partial) parses, keeping the text fallbacks for anything that did not parse clean |
| `543d263` | `@aliou/sh` 0.4.1 preserves heredoc commands through end of input, so the interim `rm` fallback patterns were dropped again |

Regression cover: `src/core/commands/dangerous-hidden.test.ts` — a recursive force delete hidden in
an expanding heredoc body, a `<<-` heredoc body, an extglob-wrapped substitution, an unterminated
heredoc, and an ANSI-C quoted command word. All five are invisible to structural matching without
these commits.

## The scratch exemption and recovered parses

The exemption is decided from the words a parse produced, so what recovery can and cannot do to a
word list decides whether it needs a guard. Measured on `@aliou/sh` 0.4.1:

| command | recovered words |
|---|---|
| `rm -rf /tmp/x /home/mike/models <<EOF` | `["rm","-rf","/tmp/x","/home/mike/models"]` — every target survives, the outside-scratch one refuses the exemption |
| `rm -rf /tmp/x /home/mike/models; (` | the same list |
| `rm -rf /tmp/x "/home/mike/models` | `[]` — no command survives, so no matcher runs and the text fallback patterns decide |
| `rm -rf /tmp/x /home/mike/models $(` | `["rm","-rf","/tmp/x","/home/mike/models","$(...)"]`, and a `$(...)` word is refused by `classifyScratchDelete` as non-literal |

Recovery either shows every target or loses the command, so the exemption cannot be granted for a
target the parse did not see, and `checkDangerousCommand` needs no extra condition. If upstream ever
changes recovery so a command survives with a shortened word list, that condition becomes necessary:
gate `scratchScope` on `parsedCleanly` in `src/core/commands/dangerous.ts`.

Refused:

| upstream | why |
|---|---|
| `4b65671` | deletes the built-in classifier (upstream's rubric never reached allow/block on their traffic). This fork's delegate path is the reviewer behind `features.classifier`, and the live config enables it. Read `examples/delegates/classifier.ts` as reference; do not take the deletion |
| `48b6d33` | guards PowerShell tool calls; there is no PowerShell tool here, and it conflicts with the fork's `path-access`/`permission-gate` edits |
| `ed66e7a` | shared biome config and `@aliou/pi-utils-ui` `truncateToWidth`: tooling churn plus a new dependency |
| `3c90104` | npm version bump on upstream's own release line; this fork versions separately |

Upstream keeps unreleased work in `.changeset/*.md`; after a merge, run
`pnpm changeset version` only when you intend to take a release.

Keep the clone complete. A shallow clone miscounts `HEAD..upstream/main` and
refuses to merge; `git fetch --unshallow` repairs it.
