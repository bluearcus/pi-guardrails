---
"@aliou/pi-guardrails": minor
---

Read a chat answer whose JSON lost an opening quote. A reviewer sometimes writes `"answer": in_scope"` — the value keeps its closing quote and loses the opening one — which desynchronizes the brace scan, so the answer looked like it contained no JSON at all and the review escalated as unreadable. Such values are repaired and the answer rescanned, and a truncated answer is repaired before its object is closed too.
