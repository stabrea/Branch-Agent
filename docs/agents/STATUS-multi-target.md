# mac7/multi-target — status

Builder: Claude (Opus), 2026-09-19. Branch `mac7/multi-target` from `mac7/hardening-3` (`33190532`).
Tests: `tests/multi-target.test.mjs` (15). The gap is the one STATUS-hardening-3.md ended on: a permission rule saw
one target per call.

- [x] 1. Every tool that touches several things says what they are (`targets()`), read from the run arguments
- [x] 2. The permission check judges every target; strictest answer wins; a refusal names the target
- [x] 3. The other places a call is judged: second-model reviewer, sandbox wall, MCP dry run, "Try a tool"
- [x] 4. The question card lists the files (first five, the rest folded away), en + fr
- [x] 5. Tests, each checked to fail with the new check taken out of `dist/`
- [x] Merge latest `origin/mac/cross-platform`, rebuild, retest, push — **hardening-3 was not in trunk yet** (below)

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
  For Branch's own (not outside) tools that are not commands this has no visible effect today — `rawOutcome` only
  decides whether an owner's yes is second-guessed and whether an outside tool is re-read as look-only — so it is
  kept for consistency and not tested.
- Sandbox wall (`wallContextFor`): "risky" also when any target is not simply allowed. The walled tools
  (`shell.execute`, `code.run`, `process.start`) declare no targets today, and the wall is off on Windows, so this
  is not exercised by a test here (see "Not proved").
- MCP dry run (`dryRunPlan`) and "Try a tool" without the runtime's gate (`tryTool`): `everyTargetDecision`; the dry
  run's `files` lists every target.
- Plan mode (`offPlanDifference`): judges whether a step changes anything, from the permission, which is already the
  strictest reading across the targets; the card's label and file list name them. No change.
- The conversation's own mode (Ask first / Plan / Auto / Full, redesign phase 1, merged from trunk): each mode is a
  policy (`policyForMode`: Plan = the read-only preset, Auto = "Just do it inside my workspace"), handed to
  `checkPolicy`'s `policy` with the task's `runId`, so every target is weighed under the conversation's mode. There
  is no separate workspace-boundary check for Auto: Auto is that preset's rules, and each tool keeps its own path
  confinement (`WorkspaceFiles`, `parsePatch`'s `..` refusal). Tests: Auto lets workspace changes through but a patch
  with a file in a refused folder is still refused; in Plan, comparing two files is fine unless one is refused.

## Behaviour changes worth knowing
- `files.patch` had no target at all (empty string). It is now "2 files: a, b". An "Always" given for it before
  this change was saved as `match: "*"` and still covers every `files.patch`; a new "Always" is for that set of files.
- `code.patch`'s target list is now read by `parsePatch` instead of a regular expression (same files for any patch
  that applies; a rename now lists its old path too). A dry run of `code.patch` / `code.change_set` is now judged
  on the files it reads, so "never anything under finance" refuses a dry run that would show a finance file.
- `knowledge.create` now has a target (its sources, joined), shown on its question.
- Cost: `checkPolicy` parses a patch once more (max 128 KiB) for the rules; the card's list is worked out only when
  the call asks; the wall's clause parses it again only for the three walled tools, which declare no targets.

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

- After the merge of trunk (`677e7d34`, redesign phase 1 and its UI fix; `0332d8be`, `f59e151f`): build and tsc
  clean; the same 39 files plus conversation-mode, redesign-phase1 and web-ui: 717 tests, 700 pass, 0 fail, 17
  skipped; after the last small change (the card's list only when asking) and the second merge: multi-target,
  static-assets, index-structure, handbook, ui, redesign-phase1, conversation-mode: 67/67.
- **Trunk did not contain hardening-3** when merged (`git merge-base --is-ancestor 33190532 origin/mac/cross-platform`
  said no, twice). This branch therefore carries hardening-3's commits as well as its own; the integrator merging
  it reviews both, unless hardening-3 lands first. The first merge commit (`0332d8be`) is missing the
  Co-Authored-By line (pushed before it was noticed; not rewritten, to avoid a force-push).

## Not proved
- The sandbox wall's new clause: no walled tool declares targets, and `wallContextFor` returns at once on Windows.
- The reviewer's new clause is not exercised by a test (it needs a second model); it reuses `judgeTargets`.
- The card was checked by reading the code and the locale files, not in a browser.

## Integration (adversarial review, 2026-09-19)
Integrator: Claude (Opus). Reviewed at `2bd7c259`; fixes on this branch, each with a test that was checked to
fail with the fix taken out of `dist/`.

Found and fixed:
- **"Always" for a long list covered another list** (blocking). `fileList` showed the first 7 paths and "…", so
  an Always for 8 files `src/f0..f7` also allowed `src/f0..f6` + `finance/secret.csv` — the whole call and, through
  `callTarget`, every file in it. A list too long to show whole now ends "and N more (list <16 hex of sha256 of every
  path>)", so a standing answer names one set only; the text also stays under the 500 characters a rule's match
  holds (seven long names used to make "Always" throw). `knowledge.create`'s target (`join(", ").slice(0, 300)`, which
  had the same collision) now uses `fileList` too.
- **"Always" on a dry run became `match: "*"`** (blocking, older than this branch but now reachable more often). A dry
  run of `code.patch` / `code.change_set` had the target "", and `match: target || "*"` made the answer a standing
  yes for every patch to any file. A dry run is now named "look at 2 files: a, b".
- **A `*` in a whole-call answer** ("2 files: src/a.ts, *", a file really called `*`, or an owner's `*src*`) matched
  other files through `callTarget`. The whole-call match now only counts when the rule's match has no `*` (a plain
  standing answer); an old `match: "*"` still covers every file as before, through the file's own match.
- **A whole folder reached a refused folder inside it.** `git.diff` / `git.status` / `git.commit` on "." (the
  workspace), and `knowledge.create` / `knowledge.add` with the folder ".", were allowed under "never anything under
  finance" and would show finance's lines, save its changes or index it. A target can now say `folder: true` (a git
  repository folder when no file is named; a knowledge source of kind folder), and a path rule that asks or refuses
  about a folder that could lie inside it counts (`innerFolderRule`, src/policy-targets.ts); the refusal names the
  inner folder. An allow for an inner folder never lets the whole folder through; a read-only folder still lets a
  diff through and stops a commit. `knowledge.add` now declares its target for this. A plain folder name is a whole
  name ("fin" is not inside "finance"); a pattern with `*` counts when its fixed start could lead inside.
  **Visible change beyond the builder's**: an owner with any rule that refuses (or asks about) a folder now gets
  that refusal (or question) for the git tools on the whole workspace — `folder` defaults to "." — and for a
  knowledge base of the whole workspace, because they reach that folder. Git on a folder beside it, or naming the
  files (`git.log path`, `git.commit paths`), is judged on those as before.
- **Speed**: a 500-file patch took ~1.5–2.3 s per `checkPolicy`, almost all in `protectedTarget` following each path
  through the file system (each path was checked twice, as target and as `args.path`). Now once per distinct path:
  ~0.25–0.35 s on this machine before the merge, 0.45–0.9 s after it (same probe, with other agents' test runs
  on the machine; `realpath` in `protectedTarget` still dominates the profile). Not held by a test (a timing test
  would be a CI flake); measured with a probe.

Checked and left as is:
- Patch forms: CRLF, `\ No newline`, quoted paths with spaces, `a/`/`b/` prefixes, `--- /dev/null` (add) are read by
  `parsePatch`, the same reader the tools apply with, and a folder rule refuses each. `+++ /dev/null` and `*** Delete
  File:` / `*** Move to:` were refused by the applier long before this branch (`fd0643cb`); refusing them here is the
  single source of truth, not a regression, so they are not turned into delete targets for an applier that cannot delete.
- `..` is refused by the patch reader; git's `paths: ["../finance/x"]` is refused (the join lands in finance).
  Absolute paths in `code.change_set` are not matched by a folder rule but the tool refuses them (`files.checked`).
  Case: rules match case-insensitively. Windows 8.3 short names: not generated on this machine's drive (`dir /x`
  shows none), so not reachable here; a longer folder name on a volume with 8.3 names on is a general gap in every
  file tool, not this branch's.
- An "Always" answered for a call that a folder rule asks about is saved but never takes effect (the folder rule is
  weighed first), so that question comes back each time. That is the rule working; noted for the card's wording.
- Household people (roles are by category and project, call-level), chat-app and outside-started tasks
  (`cappedPolicy` drops allow rules, so no Always counts), Lockdown: unchanged, and each target is weighed under the
  same capped policy.
- Card: plain words, first five then folded, en + fr present. Not checked in a browser.
- `0332d8be` has no Co-Authored-By line; left alone (no force-push).
- Not fixed, larger than this branch: `code.search` / `files.list` / `files.search` on "." still read inside a
  refused folder (they have one target); they would need their results filtered by the rules.

### Merge with trunk (hardening-3 integrated, 98beb5d8)
- Waited for hardening-3's integration to land on trunk (`98beb5d8`, with outside-resume), then merged it here.
  Four conflicts, all at hardening-3's `registry.resourceOf` / outside-resume's `sourceOf`: the imports in
  `approval-reviewer.ts`, `mcp-policy.ts`, `playground.ts`, `runtime.ts` (trunk's, plus `policy-targets`), the MCP
  dry run (trunk's `registry.resourceOf` for the whole call, then every target), and the model's question card
  (trunk's `this.sourceOf(context)` with this branch's `files`).
- **Found by the merge (blocking, fixed)**: `judgeTargets` read each target with the bare `resourceOf`, so the path
  as written from the workspace (hardening-3's `inWorkspace`, while a project's folder is active) was missing for
  every file but the call's own. With the project folder `work` and "never anything under work/finance", the second
  file of a patch (`finance/q1.csv`) went through. `TargetsCall.resourceOf` is now required: the runtime, the
  reviewer, the MCP dry run and "Try a tool" hand it `registry.resourceOf`; the whole-folder check reads "." as the
  project's folder. The sandbox wall keeps the bare reader, as its own whole-call check does (off on Windows).
  Test: "integration: every file is judged as written from the workspace while a project's folder is active".
- After the merge `./././finance/b.csv` in a patch is refused (hardening-3's `tidyPath`), which it was not before.

### Runs after the merge
`dist/` deleted and rebuilt, `npx tsc --noEmit` clean. 45 files at `--test-concurrency=2` (multi-target,
hardening-2/3, approvals, code-*, coding-*, conversation-mode, docs-memory-2, documents, folder-trust, git,
household-profile, knowledge, leak-guard, lockdown-*, manual-actions-gate, mcp-*, never-break-deny, os-sandbox,
outside-resume, plan-act, policy-outside-hold, rag-vector, redesign-phase1, second-opinion, static-assets,
index-structure, handbook, server, ui, shell-ui, calm-ui, chat-live, web-ui, catalog-diet, tool-safety,
tracing-policy): 741 tests, 724 pass, 0 fail, 17 skipped; `tests/automation.test.mjs` alone 5/5. Before the merge,
`git.test.mjs` "parallel copies stay inside .branch-worktrees" failed once under load ("Git could not do that")
and passed alone (14/14) and in the run after the merge.
Every fix here was checked by taking it out of `dist/` and seeing its test fail (6 mutations, 6 failures).

Verdict: MERGE WITH FIXES.
