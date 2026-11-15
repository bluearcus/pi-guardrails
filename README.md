![banner](https://assets.aliou.me/github/aliou/pi-guardrails/banner.png)

# Guardrails

> [!WARNING]
> I am not responsible for any issues, damage, or data loss caused by agents, even when using Guardrails. Guardrails is not a sandbox and does not guarantee safety. You are responsible for adding and maintaining rules that prevent dangerous operations in your environment; do not rely on the defaults alone.

Guardrails adds safety checks to Pi so agents are less likely to read secrets, write protected files, access paths outside the workspace, or run dangerous shell commands by accident.

The package installs four Pi extensions:

- **guardrails** — file protection policies, settings, onboarding, and examples.
- **path-access** — controlling access outside the current workspace.
- **permission-gate** — confirming or blocking risky shell commands.
- **herdr** — reporting Guardrails approval prompts to Herdr.

## Install

```bash
pi install npm:@aliou/pi-guardrails
```

## First run

After installing, run the onboarding command to choose a starting setup: `/guardrails:onboarding`. You can change everything later with `/guardrails:settings`.

[![Guardrails onboarding walkthrough](https://assets.aliou.me/github/aliou/pi-guardrails/v0.22.0/onboarding.gif)](https://assets.aliou.me/github/aliou/pi-guardrails/v0.22.0/onboarding.mp4)

## Included extensions

### guardrails

Protects files like `.env`, private keys, local credentials, database dumps, or any project-specific path you do not want Pi to read or modify without clear intent. Rules respect the current working directory by default and are configurable in the settings UI.

[![Guardrails policies and settings walkthrough](https://assets.aliou.me/github/aliou/pi-guardrails/v0.22.0/policies.gif)](https://assets.aliou.me/github/aliou/pi-guardrails/v0.22.0/policies.mp4)

Use `/guardrails:examples` to add common policy and command presets without replacing your existing config.

[![Guardrails examples command walkthrough](https://assets.aliou.me/github/aliou/pi-guardrails/v0.22.0/examples.gif)](https://assets.aliou.me/github/aliou/pi-guardrails/v0.22.0/examples.mp4)

### path-access

Checks tool calls that target paths outside the current working directory. It can allow, block, or ask before Pi accesses files elsewhere on your machine; in ask mode, you can allow a file or a directory once, for the session, or always. By default, checks apply to both reads and writes outside the workspace, and "always" grants are saved to the project config — both are configurable through `/guardrails:settings`.

[![Guardrails path access prompt walkthrough](https://assets.aliou.me/github/aliou/pi-guardrails/v0.22.0/path-access.gif)](https://assets.aliou.me/github/aliou/pi-guardrails/v0.22.0/path-access.mp4)

### permission-gate

Detects dangerous bash commands before they run — recursive deletes, privileged commands, disk formatting, broad permission changes, and any custom patterns you configure. The prompt answers a **class** of command, not only the one on screen: allow this command once (`y`), allow its class for the session (`a`), always allow the class (`A`), deny (`n`), or decline and stop (`s`), which also aborts the current turn.

**A grant covers the rule that flagged the command, not the command string.** Grants live in `permissionGate.allowedClasses` as `builtin:<what the flag was called>` for a built-in match or `pattern:<pattern>` for a configured one, so a grant for `recursive force delete` covers the next `rm -rf` too — a different path, a relative path, or a target built from a variable. A session grant lives in memory and resets on `/reload`; an always grant is saved to the scope `permissionGate.alwaysScope` names, the project config by default. Review or revoke them in Settings → Permission Gate → Allowed command classes.

Allowed commands (`permissionGate.allowedPatterns`) still bypass the gate entirely. Auto-deny patterns are matched before a class grant is consulted, so a grant cannot rescue a command you auto-denied. Auto-deny patterns can set `terminate: true` to end the agent's turn after blocking, so it does not retry the blocked command.

Command, policy, and path checks also look inside command and process substitutions, so a risky call wrapped in `$(...)` is still caught.

**Recursive deletes inside the agent's scratch root are not flagged.** `rm -rf /tmp/build` removes working data the agent made for the current task, so a delete whose every target sits inside a scratch root runs without a prompt or a review. The roots are `permissionGate.scratchDelete.roots` — `/tmp` by default, and a relative entry names a directory inside the working directory, so `.` makes the workspace itself scratch and `build` only its build directory. A relative target is placed in the directory the tool call started in, which is why `rm -rf build` in a session working from `/tmp/work` runs unflagged.

The exemption is refused whenever the delete could leave the root: a wildcard or variable, the scratch root itself, a path that passes through a symlink, or a relative target in a command that moves the working directory (`cd`, `pushd`) — the gate knows where the call started, not where a `cd` leaves it. A command that cannot be parsed into structure is never excused, and `sudo rm -rf /tmp/x` is still flagged as a privileged command. Switch the exemption off with Settings → Permission Gate → Scratch deletes, and set the roots under Scratch roots.

[![Guardrails permission gate walkthrough](https://assets.aliou.me/github/aliou/pi-guardrails/v0.22.0/permission-gate.gif)](https://assets.aliou.me/github/aliou/pi-guardrails/v0.22.0/permission-gate.mp4)

### herdr

The included Herdr adapter reports active Guardrails approval prompts through Herdr's `herdr:blocked` event, so Herdr can show the Pi pane as blocked while a prompt waits for a decision. It has no configuration and no effect unless Herdr's Pi integration is active.

Approval prompts also report `blocked` program status (OSC 7501) natively through the `blocked` option of `ctx.ui.custom()`, so terminals such as Rex show Pi as blocked while a prompt waits; no extension is needed for that anymore.

## Decision delegation

Before permission-gate or path-access prompts you, other extensions can decide for you. If every registered delegate allows the action, it runs without a prompt; if any blocks it, it is blocked; anything else, including a timeout, falls back to the usual prompt. Each decision shows up under the tool call as a `[guardrails]` line.

Delegation runs with or without a UI, so `pi -p` and JSON sessions get the same allow or block instead of an outright block. When an action still needs you, the reviewers' reasoning is shown with the prompt, and a headless block carries it in the reason the model sees.

The built-in model reviewer judges whether a flagged action is in scope of what you asked. A model the catalogue lists as a classifier is asked through Pi's classify API; any other model — a cloud chat model such as `google/gemini-3.1-flash-lite` — is asked the same rubric and answers as JSON. Enable it with `features.classifier` (Settings → Features → Classifier).

A request to do a task covers the housekeeping doing it needs, so a reviewer that judges an unrequested step trivially reversible runs it instead of asking — the same reasoning that prices a scratch delete as impact 0–1. Set `classifier.allowUnrequestedLowImpact` to `false` (Settings → Classifier → Act on implied housekeeping) to be asked about anything your request does not clearly cover, however small its effect.

See [docs/decision-delegation.md](docs/decision-delegation.md) for the rules, the reviewer, and how to write a delegate, with runnable examples in `examples/delegates/`.

## Extension events

Guardrails emits paired events on Pi's shared event bus: `guardrails:prompt:opened` when an interactive prompt starts waiting for input and `guardrails:prompt:closed` when it stops. Both carry the same `prompt.id` for correlation.

Decision delegation events are listed in [docs/decision-delegation.md](docs/decision-delegation.md#events).

## Configuration

Most configuration happens through the interactive settings UI (`/guardrails:settings`). Advanced users can edit the settings file directly:

- Global: `~/.pi/agent/extensions/guardrails.json`
- Project: `.pi/extensions/guardrails.json`

Project settings apply only after Pi trusts the folder (`/trust`, then restart Pi). Until then, untrusted project files are ignored and left unchanged, while global settings and built-in protections still apply. Set `pathAccess.alwaysScope` to `"global"` to save "always" path grants without trusting the project.

Saved files include a `$schema` field for editor autocomplete and validation; the schema is committed at [`schema.json`](schema.json).

## Similar but different

Pi is designed to make agent safety extensible. Guardrails focuses on deterministic, configurable file policies, path access control, and dangerous-command prompts. See [pi.dev/packages](https://pi.dev/packages) for the full registry.

Closest alternatives:

- [@gotgenes/pi-permission-system](https://pi.dev/packages/%40gotgenes/pi-permission-system): broad permission enforcement for Pi tool calls.
- [@vtstech/pi-security](https://pi.dev/packages/%40vtstech/pi-security): command, path, network, mode, and audit controls.
- [@casualjim/pi-heimdall](https://pi.dev/packages/%40casualjim/pi-heimdall): secret exposure guards, command policies, protected `.env` files, and a sandbox guard.
- [pi-sandbox](https://pi.dev/packages/pi-sandbox): OS-level sandboxing for bash, with allow/deny checks and prompts for file tools.
- [pi-container-sandbox](https://pi.dev/packages/pi-container-sandbox): runs read, write, edit, bash, and user bash operations inside a container session.

You can also make your own: start from the [Pi permission gate example](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/extensions/permission-gate.ts) and ask Pi to customize it for your workflow.

## Development

```bash
pnpm test         # Run tests
pnpm test:watch   # Run tests in watch mode
pnpm typecheck    # Type check
pnpm lint         # Lint
pnpm format       # Format
pnpm gen:schema   # Regenerate schema.json
pnpm check:schema # Verify schema.json is current
```
