---
"@aliou/pi-guardrails": minor
---

Add decision delegation: before permission-gate or path-access prompts, registered delegates can allow, block, or escalate the action (any block blocks, every delegate must allow, anything else prompts). Each decision is recorded as a `[guardrails]` session entry. Includes a built-in classifier delegate (`features.classifier`) that uses Pi classifier models with fallback, random, or consensus strategies.

A reviewer's reason is spelled in the terms you read it in, not the terms of the rubric behind it: `your request covers this, impact 1.5/4`, `your request probably covers this, but only 82% sure`, `not covered by your request, impact 3.0/4`.
