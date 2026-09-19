# mac7/walk-rules — status

Builder: Claude (Opus), 2026-09-19. Branch `mac7/walk-rules` from trunk `98beb5d8`. Tests: `tests/walk-rules.test.mjs`.
The hole (STATUS-hardening-3.md, Integration, "Should fix"): under "never anything under finance", `files.grep {path: "."}`
returned `finance/q1.txt`'s text. A walker was judged by the folder it starts from only.

- [x] 1. One shared check: may this task list / read this path (`Runtime.pathCheck`, `src/walk-rules.ts`)
- [x] 2. The file walkers: files.list, files.search, files.glob, files.grep, files.find, workspace.map, code.map
- [ ] 3. Knowledge bases and indexes: never add or refresh from a refused path; filter answers at read time
- [ ] 4. workspace.snapshot and exports that go to the model or leave the machine
- [ ] 5. The rest of the walkers (see the list below)
- [ ] 6. Mutation proof, merge latest `origin/mac/cross-platform`, rebuild, retest, push
