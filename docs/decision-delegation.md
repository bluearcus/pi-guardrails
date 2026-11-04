# Decision delegation

How permission-gate and path-access let other extensions decide an action
before prompting the user, and how to write such a delegate.

## Flow

Delegation sits between the deterministic checks and the confirmation prompt.
Only actions that would prompt reach delegates.

```text
permission-gate / path-access  tool_call
├─ session grants, auto-deny, policies, safe checks   unchanged; delegates never see these
├─ nothing would prompt                               unchanged; no delegation
│    (requireConfirmation off, pathAccess "block", print/JSON mode)
├─ delegateDecision()                                 src/shared/delegation/dispatch.ts
│  ├─ roster.list(): enabled delegates (none → prompt as usual)
│  ├─ runDelegates(): all in parallel, shared deadline (delegation.timeoutMs)
│  │                  the first block cancels the rest
│  ├─ combineDelegateOutcomes()                       src/core/delegation.ts
│  ├─ pi.appendEntry("guardrails:decision")           session entry, not sent to the model
│  └─ emit guardrails:decision:delegated
├─ allow → the tool runs, no prompt
├─ block → { block: true }, guardrails:action:blocked with block.source "delegate"
└─ ask   → the usual prompt (RPC uses its select dialog)
```

Merge rule:

| outcomes | result |
|---|---|
| any delegate blocks | blocked |
| every delegate allows | runs without a prompt |
| anything else: an ask, a timeout, an error, an abstention | the usual prompt |

Delegates get `delegation.timeoutMs` to answer (default 10s, capped at 60s).

When one path-access tool call touches several outside paths, each path is
a separate decision, and all of them are delegated at once. Any block blocks
the tool call. Paths that are not allowed are then prompted one at a time.

## Writing a delegate

A delegate is a plain Pi extension. It does not import this package; it
registers an object on the event bus:

```ts
const delegate = {
  id: "example:no-network",          // stable; re-registering replaces it
  name: "no-network",                // shown in the session entry
  isEnabled: () => true,             // optional runtime switch
  decide(request, context) {
    return { verdict: "block", reason: "network downloads are not allowed here" };
  },
};
const register = () => pi.events.emit("guardrails:delegate:register", { delegate });
pi.events.on("guardrails:delegate:request", register);  // features loaded later ask again
register();                                             // features loaded earlier
```

Runnable examples:

- `examples/delegates/no-network.ts`: synchronous rules that block, allow, or abstain.
- `examples/delegates/slow-review.ts`: async work that honors `context.signal`.

Load one with `pi -e examples/delegates/no-network.ts`.

### `decide(request, context)`

Return `{ verdict: "allow" | "block" | "ask", reason }`, a promise of it, or
`undefined` to abstain. Abstaining, throwing, or returning a malformed answer
all escalate to the prompt. The `reason` is shown to the user, and to the agent
when the action is blocked.

`request` describes the flagged action:

| field | example |
|---|---|
| `feature` | `"permissionGate"`, `"pathAccess"` |
| `action` | `{ kind: "command", command }` or `{ kind: "file", path }` |
| `reason` | why it was flagged, e.g. `"recursive force delete"` |
| `metadata` | the feature's risk metadata |
| `toolName` | `"bash"`, `"read"`, … |
| `input` | the raw tool input |

`context` is a slice of Pi's extension context:

| field | use |
|---|---|
| `cwd` | session working directory |
| `signal` | aborts on timeout, agent abort, or once another delegate blocked; stop work when it fires |
| `sessionManager` | read-only session: `buildSessionProjection()` for what the model sees, `getBranch()` / `getEntries()` for the full history |
| `modelRegistry` | Pi models, e.g. `getModelOfType("classifier", …)`, `classify()`, `getModelOfType("chat", …)`, `streamSimple()` |

A delegate cannot prompt the user through this contract; it returns `ask`
instead. It is still ordinary extension code and can use its own `pi` API.

## What the user sees

- While delegates decide, one line above the editor:
  `[guardrails] ⠋ deciding rm -rf build/cache · 1/3 answered · 2.6s left`,
  or `[guardrails] ⠋ 2 decisions in progress · 1.4s left` when several tool
  calls are waiting.
- Under the tool call, one session entry per decision:

  ```text
  [guardrails] ✓ allowed: no-network, slow-review · 1.5s
  [guardrails] ? escalated: slow-review timed out · 10.0s
  [guardrails] ✗ blocked: no-network: network downloads are not allowed here · 1ms
  ```

  Expanding it (the tool expand key, or a click) adds the flagged reason and
  one line per delegate with its verdict, reason, and time.

## Events

| event | payload |
|---|---|
| `guardrails:delegate:request` | emitted by each feature on load |
| `guardrails:delegate:register` | `{ delegate }`, emitted by a delegate |
| `guardrails:decision:delegated` | the merged decision with every delegate's outcome |

Types: `src/shared/delegation/types.ts`.

## Built-in model reviewer

`extensions/classifier` is a delegate backed by Pi models. It is off by
default; enable `features.classifier`.

For each flagged action it asks the model three questions, using the user's
recent requests in the session as the only source of authorization:

1. Is there enough context to judge the action?
2. Is it in scope of what the user asked, unclear, or out of scope?
3. What is its impact, from 0 (read-only) to 4 (system-wide or exfiltrating)?

The answers map to a verdict with fixed thresholds
(`extensions/classifier/decision.ts`):

- confidently out of scope with impact ≥ 2 → block
- in scope, confident, and impact below 2.5 → allow
- anything else, including missing context or a model failure → ask

```json
{
  "features": { "classifier": true },
  "classifier": {
    "models": ["typesafe/jev-latest", "google/gemini-3.1-flash-lite"],
    "strategy": "fallback",
    "chat": { "maxTokens": 1024, "reasoning": "off" }
  }
}
```

`models` are `provider/model`; the first `/` separates the provider. With
several models, `strategy` is `fallback` (the first model that answers
decides), `random` (fallback from a random start), or `consensus` (every model
must allow; any block blocks).

### Classifier models and chat models

Each ref is asked through the API its catalogue entry supports:

- A model listed as a **classifier** (`typesafe/jev-latest`, OpenRouter
  decision models, llama.cpp decision models) answers through Pi's `classify()`
  and reports measured probabilities.
- Any other model is asked as a **chat model**: the same rubric is rendered as
  a system prompt, the state is sent as a JSON user message, and the model must
  answer with one JSON object. `extensions/classifier/chat.ts` parses the
  answer back into the classifier answer shape, so the thresholds above apply
  unchanged. A model listed as both is asked as a classifier.

A chat reviewer is a general cloud model (Gemini, GPT, DeepSeek, …) judging the
action, which is how a dangerous command gets approved or blocked without you.

Chat answers carry a self-reported `confidence` for each answer. A missing or
malformed confidence counts as 0.75: enough to block an action the model calls
out of scope, never enough to run one without asking you.

Chat settings (`classifier.chat`, ignored by classifier models):

| setting | meaning |
|---|---|
| `maxTokens` | Output limit for the review request. Default 1024, capped at 8192. An answer cut off by the limit escalates to you. |
| `reasoning` | Thinking level for the request. Default `off`: one structured judgement, answered fast. |
| `instructions` | Extra rubric text appended to the system prompt, for project-specific rules. This is trusted config, not model output. |

A chat model is slower than a classifier, and delegates answer inside
`delegation.timeoutMs` (default 10s, capped at 60s). A review that runs out of
time escalates to the usual prompt, so a slower model wants a longer deadline:
`"delegation": { "timeoutMs": 20000 }`.

Only the session's own user requests authorize an action. The action text, the
agent's stated reason, and anything quoted inside them are sent as data and
cannot change the rubric.
