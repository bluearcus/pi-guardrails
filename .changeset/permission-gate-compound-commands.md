---
"@aliou/pi-guardrails": minor
---

Follow the working directory through the command. The cleanup commands people
actually run are compound — `cd /work/follow9/build && make && rm -rf $BDIR` —
and the gate threw away the one thing that made them answerable: any `cd` made
the working directory unknown, so the flagged delete was placed nowhere, could
not be covered by a grant, and had no directory to offer. The directory is now
read out of the parsed program in `src/core/commands/working-directory.ts`: a
literal `cd` or `pushd` moves it, `cd` with no target, `cd -`, `popd` and a `cd`
the shell fills in lose it, a subshell, pipeline element or command substitution
is scoped, a loop, `if` or `case` body places the commands inside it and loses
the directory afterwards, and a function definition whose body moves the
directory loses it until a literal `cd` restores it.

Coverage, the scratch exemption and the grant offer are each decided against the
directory the flagged command itself runs in. `cd /work/build && rm -rf $BDIR`
now prompts with `Allow recursive force delete of /work/build this session`,
a grant for `/work/build` excuses it and what is under it, `cd /tmp/work && rm -rf
build` is ordinary scratch cleanup, and `cd build && rm -rf ..` is still refused
— it would need authority over everything next to the build directory. A command
the gate cannot place (`cd $WORK && rm -rf build`) is still allowed once or not
at all.

Core API: `checkDangerousCommand` takes `scratchRoots` instead of a
`scratchScope`, plus `home` so a literal `cd ~/work` can be placed, and offers
the directories a prompt may grant for with `grantOffersForCommand()`;
`grantOfferFor`, `deleteTargetsFor` and `commandIsPlaceable` are gone.
