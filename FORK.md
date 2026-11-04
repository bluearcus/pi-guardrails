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

Three independent paths:

1. **On demand, locally** — `pnpm upstream:check`. Prints the unmerged upstream
   commits and exits nonzero when there are any, so it composes in scripts:
   `pnpm upstream:check || echo "merge upstream before shipping"`.
2. **On GitHub** — `.github/workflows/upstream-sync.yml` runs daily (and on
   manual dispatch), and opens or updates one issue labelled `upstream-sync`
   listing the commits to merge. GitHub notifies you on that issue. Scheduled
   workflows are suspended on repositories with no push for 60 days, so push at
   least every two months, or run the workflow manually.
3. **Inside Pi** — `tools/upstream-watch.ts` checks at session start and adds an
   `/upstream` command:

   ```sh
   pi install <repo>/tools/upstream-watch.ts
   ```

   ```json
   // ~/.pi/agent/upstream-watch.json
   {
     "repos": ["/home/mike/Sync/Projects/PiCodingHarness/pi-guardrails"]
   }
   ```

## Merging upstream

```sh
pnpm upstream:check          # what is coming
git fetch upstream
git merge upstream/main      # conflicts: resolve, keeping the fork's changes
pnpm install                 # lockfile changes need reconciling
pnpm typecheck && pnpm test && pnpm lint
pnpm check:schema            # regenerate if config types changed: pnpm gen:schema
pnpm changeset               # describe the merge if it changes behaviour
```

Upstream keeps unreleased work in `.changeset/*.md`; after a merge, run
`pnpm changeset version` only when you intend to take a release.
