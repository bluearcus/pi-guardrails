---
"@aliou/pi-guardrails": minor
---

Offload the permission gate decision to a cloud model. `classifier.models` now accepts any `provider/model`: a model the catalogue lists as a classifier keeps Pi's classify API, and any other model is asked the same rubric as a chat model and answers with JSON, mapped through the same rubric. Chat reviews take `classifier.chat` settings (`maxTokens`, `reasoning`, `instructions`, `allowConfidence`), configurable in Settings → Classifier; a chat reviewer runs an action at 0.8 confidence instead of the classifier's 0.85, because a model rating its own answer sits lower than a measured probability. Answers with a bare label or a trailing comma are repaired before parsing. A review that cannot be read, times out, or is not confident enough still escalates to you. The default reviewer model is `opencode-go/deepseek-v4.1-flash`.
