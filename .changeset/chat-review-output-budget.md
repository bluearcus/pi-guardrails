---
"@aliou/pi-guardrails": minor
---

Give chat reviews an output budget that covers their reasoning. `classifier.chat.maxTokens` defaults to 4096 instead of 1024: a thinking model spends its reasoning and its JSON answer out of one shared budget, and a composite command with several targets could spend all 1024 tokens on reasoning and return nothing to read. An answer the limit cut off is now parsed from the entries that did arrive — the object is closed and a dangling key dropped — so a review is only lost when an answer is missing one of the rubric questions.
