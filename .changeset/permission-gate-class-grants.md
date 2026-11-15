---
"@aliou/pi-guardrails": minor
---

Answer the permission gate once and it carries. "Allow for session" stored a
regex for the exact command that was on screen, so the next cleanup of the same
kind prompted again and the answer changed nothing. A grant now names the class
that was flagged — `builtin:<what the flag was called>` for a built-in match,
`pattern:<pattern>` for a configured pattern — and covers every command that
rule flags, including ones written with a relative path or a variable. The
prompt states what each answer covers (`y` once, `a` the class for this session,
`A` always, `n` deny, `s` decline and stop), and an always grant is saved to
`permissionGate.allowedClasses` in the scope `permissionGate.alwaysScope` names,
the project config by default. Edit or revoke grants in Settings → Permission
Gate → Allowed command classes. A granted class is read before decision
delegates run, and auto-deny patterns are still matched first.
