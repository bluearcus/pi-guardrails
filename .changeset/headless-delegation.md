---
"@aliou/pi-guardrails": minor
---

Delegate decisions in headless sessions, and show the reviewers' reasoning when an action still needs you. `pi -p`, JSON, and RPC sessions now consult decision delegates before blocking a flagged action: an allow runs it, a block blocks it, and anything else falls back to the headless block it would already have been, with the review reasoning attached (`Dangerous command blocked (no UI to confirm): recursive force delete. Model review (2.4s): classifier: outside what you asked for, impact 3.0/4`). In interactive sessions the confirm prompt, the path-access prompt, and their select fallbacks show the same `Model review (…)` line above the decision.
