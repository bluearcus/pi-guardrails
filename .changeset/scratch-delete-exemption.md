---
"@aliou/pi-guardrails": minor
---

Stop flagging recursive deletes that stay inside the agent's scratch root.

`rm -rf /tmp/build` is the agent's own working data, so a recursive force delete
whose every target sits inside a scratch root (`/tmp` by default, set in
`permissionGate.scratchDelete.roots`) no longer prompts and is not sent for
review. The exemption is checked structurally and refused when the delete could
leave that root: a relative target, a wildcard or variable, the scratch root
itself, or a path that passes through a symlink. Commands that cannot be parsed
into structure keep the usual flag, as do privileged ones such as
`sudo rm -rf /tmp/x`.
