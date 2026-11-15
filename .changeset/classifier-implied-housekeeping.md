---
"@aliou/pi-guardrails": minor
---

Let the reviewer act on housekeeping your request implies. A cleanup nobody
named scored `unclear` on the authorization axis, and `decide()` asked about an
unclear action whatever its impact — so the reviewer's own rule that replacing
the agent's scratch, clone, build, or cache data is trivially reversible could
never be reached. Scope now answers "does the request cover this step", and a
request to do a task covers the housekeeping doing it needs: an unclear step with
enough context and impact below 1.5 is acted on. Anything at or above that
impact, and everything out of scope, behaves as before.

The rubric says the same to the model: implied housekeeping of the agent's own
working data is `in_scope`, and it still does not cover your source or data.

Turn it off with `classifier.allowUnrequestedLowImpact: false` (Settings →
Classifier → Act on implied housekeeping) to be asked about anything your request
does not clearly cover, however small its effect.
