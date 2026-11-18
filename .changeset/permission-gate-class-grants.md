---
"@aliou/pi-guardrails": minor
---

Answer the permission gate once and it carries — for the directory the delete
hits. "Allow for session" stored a regex for the exact command on screen, so the
next cleanup of the same kind prompted again and the answer changed nothing. A
grant is now a pair: the class that was flagged (`builtin:<what the flag was
called>` for a built-in match, `pattern:<pattern>` for a configured pattern) and
one directory. For a recursive delete that directory is the one the delete
impacts: `rm -rf scratch` in `~/project` is a grant for `~/project/scratch`, which
covers deleting that directory and anything under it and says nothing about the
rest of `~/project`. A command that deletes several directories is covered only
when each has its own grant — `rm -rf build out` is two — and a wildcard counts
where its literal part sits, so a grant for `/tmp/work/build` covers
`rm -rf build/*` there and not `rm -rf /home/mike/Sync/*`. A class with no path
targets is covered when the call ran inside the granted directory, and a target
written as a variable only there. A compound command is placed in the directory
its own `cd` moved the shell to, and no grant is offered for `/` or the home
directory.

Every answer states what it covers — `Allow recursive force delete of
~/project/scratch this session`, with one line per directory when one command
impacts several — and a command that impacts several can be answered directory by
directory (`c`): grant `build` for the session, allow `out` this time without a
standing grant, or refuse it. Because the command runs whole, a refusal blocks
it, while the grants chosen for the other directories are saved all the same. A
grant is only ever offered for a directory the delete was
already working in, or one under a scratch root from
`permissionGate.scratchDelete.roots`. It is never offered over the directory the
call started in, because that grant is authority over the whole project: `rm -rf .`
and `rm -rf $BDIR` at the project root, and a delete that climbs out of the
directory it runs in, are allowed once or not at all. Always grants save to
`permissionGate.grants` in the scope `permissionGate.alwaysScope` names, the
project config by default, one entry per directory so each can be revoked on its
own; edit or revoke them in Settings → Permission Gate → Command grants. A covered
command is dropped by the core check before a risk is reported, so it prompts,
emits, and reviews nothing; auto-deny patterns are still matched first.
