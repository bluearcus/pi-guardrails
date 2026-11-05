---
"@aliou/pi-guardrails": minor
---

Judge replacing the agent's own working data as low impact. Deleting a scratch or clone directory, build output, a cache, or generated files that the agent produced for the current task, when a current or newer version takes its place and the session history shows how to rebuild it, now scores 0–1 on the impact rubric even when the path is outside the workspace. Previously that read as "deleting generated artifacts outside the workspace" and scored near the destructive bar. The carve-out needs a replacement: a deletion that leaves nothing behind, or that touches the user's source, data, or committed work, scores as before, and scope still has to authorize the action either way.
