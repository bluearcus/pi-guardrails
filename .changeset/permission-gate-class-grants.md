---
"@aliou/pi-guardrails": minor
---

Answer the permission gate once and it carries — for the directory it was given
in. "Allow for session" stored a regex for the exact command on screen, so the
next cleanup of the same kind prompted again and the answer changed nothing. A
grant is now a pair: the class that was flagged (`builtin:<what the flag was
called>` for a built-in match, `pattern:<pattern>` for a configured pattern) and
one directory. A recursive delete is covered when every target sits under that
directory and none of them is the directory itself; a class with no path targets
is covered when the call ran inside it; a target written as a variable or a
wildcard is covered only there. `cd`/`pushd`/`popd` in the command voids the
coverage, an action spanning directories is never covered, and no grant is
offered for `/` or the home directory.

Every answer states what it covers — `Allow recursive force delete under
~/project this session` — and when no single directory covers the action the
prompt offers only the command in front of you, with a line saying why. Always
grants save to `permissionGate.grants` in the scope `permissionGate.alwaysScope`
names, the project config by default; edit or revoke them in Settings →
Permission Gate → Command grants. A covered command is dropped by the core check
before a risk is reported, so it prompts, emits, and reviews nothing; auto-deny
patterns are still matched first.
