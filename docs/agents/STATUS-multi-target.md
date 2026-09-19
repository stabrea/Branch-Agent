# mac7/multi-target — status

Builder: Claude (Opus), 2026-09-19. Branch `mac7/multi-target` from `mac7/hardening-3` (`33190532`).
Tests: `tests/multi-target.test.mjs` (15). The gap is the one STATUS-hardening-3.md ended on: a permission rule saw
one target per call.

- [x] 1. Every tool that touches several things says what they are (`targets()`), read from the run arguments
- [x] 2. The permission check judges every target; strictest answer wins; a refusal names the target
- [x] 3. The other places a call is judged: second-model reviewer, sandbox wall, MCP dry run, "Try a tool"
- [x] 4. The question card lists the files (first five, the rest folded away), en + fr
- [x] 5. Tests, each checked to fail with the new check taken out of `dist/`
- [ ] Merge latest `origin/mac/cross-platform` (with hardening-3 and the integrator's fixes), rebuild, retest, push

## What a target is
`ToolTarget` (src/contracts.ts): `{ kind: "read" | "write" | "delete", path?, url? }`. A tool that touches more than
one thing — or whose one thing is not where the rules look — declares `targets(args, context)`, beside the old
`target()` (which stays: it is the one string the call is known by on the card, in a kept yes and in "Always").
`ToolRegistry.targetsOf(name, args, context)` parses the arguments with the tool's own schema first (the same
`runArgs` rule hardening-3 introduced), then calls it. It returns `null` for a tool that declares nothing, so every
other tool is judged byte-for-byte as before. It throws when the targets cannot be told, and the call is refused.

Declared (and a test holds the list, so a new one is noticed):
- `code.patch`, `files.patch` (had no target at all): `patchTargets` (src/patch.ts) runs **`parsePatch` itself** — the
  reader the tools apply the patch with — so both forms (`--- a/ +++ b/`, `*** Begin Patch` with `Update`/`Add
  File`) are read exactly as they will be applied. A rename (`--- a/src/x` / `+++ b/finance/x`) gives both paths
  (`PatchFile.oldPath`, new); the old one is judged as a change, since the patch says that file moves. `parsePatch`
  refuses `*** Delete File:`, `*** Move to:`, `+++ /dev/null` and `..`; a throw there means the targets cannot be
  told, so the call is refused before it runs (the tool would have refused it anyway). A dry run of `code.patch`
  reads the files (its preview shows their lines), so its targets are `read`.
- `code.change_set`: each `edits[].path` (write; read on a dry run).
- `documents.compare`: `file` and `against` (read).
- `knowledge.create`: every `sources[].path` (read); it now also has a `target()` (the list), for the card.
- `documents.edit`: with `saveAs`, `path` read and `saveAs` written; without, `path` written.
- Git: `git.status/diff/log/branch/commit/worktree_add/worktree_list/worktree_remove`, `plans.try/diff/merge`,
  `git.push/pull`, `github.publish_repo`: the repository `folder` (read for the `git.read` tools, write for the
  rest), plus `git.log`'s `path` and `git.commit`'s `paths`, joined onto the folder.

## How every target is judged (src/policy-targets.ts, src/runtime.ts `checkPolicy`)
The call as a whole is judged exactly as before. Then, for a tool that declares targets:
- each target is held to Branch's own files (`protectedTarget`, as a read or a change by its kind);
- each is weighed by the rules as if the call touched only it (`judgeTargets`): its path is the target, its
  `resourceOf` is the path (so folder rules match), and `readOnly` is its kind — so a rule that only covers
  changes ("changes under finance: never", i.e. a read-only folder) lets a read through and stops a write;
- the strictest answer wins (deny > ask > allow), never looser than the whole call's answer. A refusal returns
  `reason`: "Your settings do not allow this: …, because it would change finance/b.csv." A question keeps the
  rule's `remember`.
- A standing answer the owner gave for the whole call ("Always" on a patch writes a rule whose `match` is "2 files:
  a, b") still counts for each file: a rule's `match` may fit the file or the whole call (`PolicyRequest.callTarget`,
  src/policy.ts). Rules about a folder are weighed before it, as for a one-file call. Kept yes-answers stay bound to
  the whole call's target and the exact bytes (a yes can only get narrower).

Covered for free, no separate code: folder trust (`RunGuards.policy` caps the whole policy, which is what each
target is weighed against), the owner's "read-only folder" (a path rule on changes, above), Lockdown, roles, the
leak guard and personal holds (call-level, unchanged). Every caller of `checkPolicy` gets it: a model's turn, the
tool gate (hand-pressed tools, workflows, flows, procedures, voice, the MCP server, `coding/gated.ts`).

Other places:
- Second-model reviewer (`rawOutcome`, src/approval-reviewer.ts): the rules' own answer is made stricter by the
  targets the same way, so it never "confirms" what a target refuses; targets it cannot tell count as a refusal.
- Sandbox wall (`wallContextFor`): "risky" also when any target is not simply allowed. The walled tools
  (`shell.execute`, `code.run`, `process.start`) declare no targets today, and the wall is off on Windows, so this
  is not exercised by a test here (see "Not proved").
- MCP dry run (`dryRunPlan`) and "Try a tool" without the runtime's gate (`tryTool`): `everyTargetDecision`; the dry
  run's `files` lists every target.
- Plan mode (`offPlanDifference`): judges whether a step changes anything, from the permission, which is already the
  strictest reading across the targets; the card's label and file list name them. No change.
- Auto mode's workspace boundary: there is no such check in the code under that name. The nearest are the "Just do
  it inside my workspace" preset (rules, so covered above) and each tool's own path confinement (`WorkspaceFiles`,
  `parsePatch`'s `..` refusal). Nothing else to change.

## The card
`PendingApproval.files` and the `policy.ask` event carry `[{ kind, path }]`. The settings list (public/approvals.js)
and the question in the conversation (public/live-run.js) show "This touches N files:", the first five as
"changes src/a.ts" / "reads …" / "deletes …", and the rest under "N more" in a folded `<details>` (locale keys
`live.files`, `live.filesMore`, `live.fileRead/Write/Delete`, en + fr). One-file calls show nothing new.

## Not switchable, on purpose
This closes a hole in rules the owner already wrote ("never anything under finance" did not cover the second file
of a patch); it adds no feature and has no setting, like hardening-3 item 6. The only visible change for an
existing owner is that a call touching a folder they refused is now refused, and that a patch's question lists
its files.

## Tests (`tests/multi-target.test.mjs`)
For each multi-target tool, one allowed + one refused target is refused naming the refused one, and all-allowed
passes (`code.patch` end to end through a model's turn: nothing written; `files.patch`, `code.change_set`,
`documents.compare`, `knowledge.create`, `documents.edit` through `checkPolicy`); a rename into (and out of) a
refused folder; the envelope form; unreadable patches (words, `Delete File`, `/dev/null`) refused with "could not
tell"; git `folder` under a refused folder, `git.log` path, `git.commit` paths; a read-only folder (reads pass,
changes and git commits refused, dry-run reads pass, "never" catches the dry run); the question lists the files;
"Always" for the whole call still counts, a folder rule still beats it; MCP dry run and "Try a tool"; the list
of tools that declare targets, and the git folder kinds.

Proved by mutation in `dist/`: with `everyTarget` returning nothing in `runtime.js`, 12 of 15 fail (the three
left are the all-allowed test, the dry-run/Try test and the list test); with `everyTargetDecision` ignoring the
targets, the dry-run/Try test fails; with the `callTarget` match taken out of `policy.js`, the "Always" test fails.

## Runs
- Before the merge (at `0ba2ee81`): `npm run build`, `npx tsc --noEmit` clean; 39 files at `--test-concurrency=2`
  (multi-target, hardening-1/2/3, code-ide, code-tools, code-editor, coding-*, approvals, tool-safety, tracing-policy,
  policy-outside-hold, manual-actions-gate, folder-trust, leak-guard, never-break-deny, plan-act, git, documents,
  docs-memory-2, knowledge, rag-vector, mcp-server, mcp-mode, second-opinion, os-sandbox, static-assets,
  index-structure, handbook, ui, chat-live, calm-ui, shell-ui, server, catalog-diet): 661 tests, 644 pass, 0 fail, 17 skipped.

## Not proved
- The sandbox wall's new clause: no walled tool declares targets, and `wallContextFor` returns at once on Windows.
- The reviewer's new clause is not exercised by a test (it needs a second model); it reuses `judgeTargets`.
- The card was checked by reading the code and the locale files, not in a browser.
