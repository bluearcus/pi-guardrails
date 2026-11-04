---
"@aliou/pi-guardrails": minor
---

Offload the permission gate decision to a cloud model. `classifier.models` now accepts any `provider/model`: a model the catalogue lists as a classifier keeps Pi's classify API, and any other model is asked the same rubric as a chat model and answers with JSON, mapped through the same thresholds. Chat reviews take `classifier.chat` settings (`maxTokens`, `reasoning`, `instructions`), configurable in Settings → Classifier. A review that cannot be read, times out, or is not confident enough still escalates to you.
