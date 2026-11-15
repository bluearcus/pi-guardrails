---
"@aliou/pi-guardrails": patch
---

Read a trailing slash as the same directory. `rm -rf /tmp/build/` was refused the
scratch exemption on the grounds that a trailing slash makes `rm` follow a linked
directory, but a slash changes the spelling, not the target, and the walk `rm`
can follow is already checked link by link below the scratch root. `rm -rf /tmp/`
is still the whole scratch root and still flagged, as is a delete that reaches
its target through a link.
