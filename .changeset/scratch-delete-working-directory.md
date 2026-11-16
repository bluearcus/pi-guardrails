---
"@aliou/pi-guardrails": minor
---

Place scratch targets in the directory the command runs in. A relative delete
target — `rm -rf .layout`, `rm -rf build` — was refused exemption because the
gate was never told the working directory, so working-data cleanups inside the
workspace were flagged even though the scratch exemption existed. The tool call's
cwd is now threaded into the check and a relative target is placed against the
directory that delete runs in: `rm -rf build` in a session working from
`/tmp/work` is confined to the scratch root and runs unflagged, and so does
`cd /tmp/work && rm -rf build`, because the command says where it works. A
relative target is still refused when the directory is not one the gate can
name — `cd $WORK`, `cd -`, `popd`, or a delete inside a loop or branch whose
directory afterwards is unknown.

`permissionGate.scratchDelete.roots` now accepts relative entries, resolved
against the working directory, so a project can declare its own working data:
`.` covers the whole workspace, `build` only its build directory. Deleting a
declared root whole is still flagged. Scratch roots are editable in Settings →
Permission Gate → Scratch roots.
