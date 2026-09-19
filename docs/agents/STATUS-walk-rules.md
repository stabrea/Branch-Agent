# mac7/walk-rules — status

Builder: Claude (Opus), 2026-09-19. Branch `mac7/walk-rules` from trunk `98beb5d8`. Tests: `tests/walk-rules.test.mjs`.
The hole (STATUS-hardening-3.md, Integration, "Should fix"): under "never anything under finance", `files.grep {path: "."}`
returned `finance/q1.txt`'s text. A tool that walks a folder was judged by the folder it starts from only.

- [x] 1. One shared check: may this task list / read this path (`Runtime.pathCheck`, `src/walk-rules.ts`)
- [x] 2. The file walkers: files.list, files.search, files.glob, files.grep, files.find, workspace.map, code.map
- [x] 3. Knowledge bases and indexes: never add or refresh from a refused path; filter answers at read time
- [x] 4. workspace.snapshot and what leaves the machine (pull request from changes)
- [x] 5. The rest of the walkers (list below)
- [x] 6. Mutation proof (below)
- [x] 7. Merge latest `origin/mac/cross-platform`, rebuild, retest, push

## The check

`Runtime.pathCheck({ tool, runId, source })` (src/runtime.ts, next to `roleRefusal`) builds the check for one walk from
the same pieces `checkPolicy` uses, read once: `this.policy(source, runId)` (the owner's rules, the conversation's mode,
folder trust, and the hold on work from outside), `roleRefusal` (a household person's role: when the role refuses
the walking tool, every entry is refused) and `lockdownToolRefusal`. Branch's own unreadable files (the database, keys)
are refused by address (`unreadable`, src/never-break/protected.ts), and only looked for when one lies inside the
workspace. `checkPolicy`'s body is not changed.

`walkCheck` (src/walk-rules.ts) weighs one path as a read-only call of the walking tool **and** of `files.read`
(reading) or `files.list` (listing), so a rule about any of the three holds inside any walker:
- `deny` → left out.
- `ask` → left out when the rule that asks is about that path; kept when it is the same broad rule the walk itself
  answered to (e.g. every call asks: the walk was asked about and allowed). A walk cannot stop to ask per file; the
  task can still ask for the file by name.
- A rule on changes only (a read-only folder) never hides anything from a read.
- Rules are the owner's own, in their order: an allow for `finance/public` written before "never finance" still lets
  that folder through.
- Performance: per folder, only the rules that could name something inside it are weighed, and a folder no such rule
  reaches costs nothing (cached per directory for the walk). Measured on 3,600 files (40 folders), `files.glob **/*`:
  no rules ~0.5–0.65 s, one folder rule ~0.65 s, 51 folder rules ~0.75 s, plus a `*.csv` rule (every file weighed)
  ~1.0 s (1.8 s before the per-folder narrowing). The walk's own disk reads dominate. Not held by a test (a timing
  test would flake on CI).

`WalkRules` is one walk's bookkeeping: each folder decided once, each file once, and `note()` gives the one sentence
the answer carries as `leftOut`: "Some things were left out because the owner's rules keep this task out of them: the
folder finance; 2 files in notes. Nothing from them is shown here." Folders are named; files are only counted.
`start(path)` refuses a walk that begins inside a refused folder ("Your settings do not allow looking in finance…"); a
model's call is already refused by `checkPolicy` before that (both tested).

How a walker gets the check: `WorkspaceFiles.walkRules(outside?)`, set once in src/index.ts. Inside any tool call
(`registry.execute` now also records the tool's name in src/task-scope.ts, beside the task id it already recorded)
it is that task's rules for that tool. Outside a tool call it is **not held** (the owner's own window), unless the
caller names where the work comes from (`{ source: "mcp" | "trigger" | "owner" }`), which knowledge, the MCP resource,
the AI comment watcher and the pull-request hook do. The passages put in front of a task (`Runtime.addDocuments`) now
run under that task (`underTask`), so its rules apply to them.

**Not switchable, on purpose** (as hardening-3 item 6 and multi-target): this closes a hole in rules the owner already
wrote and adds no feature. With no path-specific rule nothing changes (no note, nothing left out; tested). No setting,
no UI string, no new tool name.

## Every walker found, and how it is covered (tests/walk-rules.test.mjs)

Held, with a test each (a refused folder's files are neither listed nor read; allowed files still are; the note):
- `files.list` (src/files.ts `list`): refused folders and files are not listed; the note. Test.
- `files.search` (`search`): one `WalkRules` for the whole search; each file checked for reading. Test.
- `files.glob`, `files.grep`, `files.find`, `workspace.map` (src/code-search.ts `walk`/`descend`). Tests.
- `code.map` and everything built on `ProjectMap` (src/code-map.ts: the Learn code map and tour, the ranked repository
  context `RepositoryContextProvider`, the outline): `leftOut` carried into `rank`/`outline`/`build`. Test (code.map).
- A walk starting inside the refused folder is refused (grep, list, glob, search). Test; `WalkRules.start` unit test.
- Knowledge bases (src/knowledge-bases.ts `sourceFiles`/`walk`): a folder or file source under a refused path is not
  read, **also when the owner presses Read again in the window** (what is read in is read back to the assistant); the
  reading's status says so; files dropped from the list are forgotten by that reading (`forgetMissing`). Test.
- Knowledge at read time: `searchWithNote` (so `knowledge.search`, `knowledge.ask`, and the attached bases put in front
  of a task) drops passages from refused files and says so in `note`; summaries (src/knowledge-summary.ts) skip them
  and never hand back a summary written while they were readable (the cache key names what is hidden); the map of names
  (src/knowledge-graph.ts `build`, `linksOf`, `passagesAround`) and the Learn document map (src/learn/map.ts) leave
  their links out, and any name no shown link comes from. Test (search in a task, the task's context, a summary, the
  map's passages).
- Knowledge pictures (src/knowledge-pictures.ts): the same walk; no separate test.
- Document library (src/documents.ts `search`, so `documents.search` and "Use my documents when answering"): a document
  read in from a workspace file now refused is not searched. Test. (This one carries no `leftOut` note.)
- `workspace.snapshot` taken by a task (src/workspace-history.ts): refused paths are not copied; `leftOut`. Test.
  **The owner's own snapshot from the window (`POST /api/history/snapshots`) and the whole-app backup are unaffected**:
  they stay on this computer and are the owner's own action. Test (the window's snapshot keeps all 4 files).
- Pull request from changes (src/pr-hook.ts `sendablePaths`; the tool and the after-task hook): a refused file never
  leaves the computer. Test (Git is never handed a finance path).
- MCP server resource `workspace://files` (src/mcp-server.ts): held as work from `mcp`. Test (real server, headless).
- AI comments watcher (src/ai-comments.ts `scan`, `branch watch --ai-comments`): a refused file is not read, so its
  comments never start a task. Test.
- Project facts for drafted instructions (src/coding/init.ts `projectFacts`): refused top-level folders and files are
  neither named nor read. Test.
- Language servers (src/language-server.ts): the places (`code.definition`, `code.references`) and problems
  (`code.diagnostics`) a server names are held to the rules (the server reads the project by itself). Test
  (diagnostics). `code.hover`'s text cannot be traced to a file and is not filtered.
- Notes folder (src/obsidian.ts `obsidian.read`) when it lies inside the workspace (`byFullAddress`). Test.
- The check itself (`walkCheck`, `WalkRules`): broad ask vs folder ask, letter case, an inner allow written first,
  `*.csv`, a rule on reading only, the active project's folder, the note's wording. Unit test. A trigger's task: test.

Covered through `files.list` (no separate test): `@folder/` mentions (they go through the ordinary gate as
`files.list`), `skills.sync` reading a skills folder (src/skill-revisions.ts), the knowledge picture walk.

Left alone, on purpose:
- **Git tools reading the working tree** (`git.status`/`git.diff` on "."): **still open on trunk; this branch does not
  close it and cannot** — git tools run git itself, so there is no walk in Branch's code to check per entry; the only
  way is to refuse the whole call. Today, under "never anything under finance", `git.diff {folder: "."}` still shows
  finance's lines. mac7/multi-target (not merged yet) does that refusal: it judges
  the repository folder as a whole-folder target (`folder: true`, `innerFolderRule`) and refuses it when a rule reaches
  a folder inside. Filtering here too would conflict with that and refuse twice. For whoever merges both: a walker must
  never declare "." as a folder target, or the whole walk is refused instead of filtered.
- The owner's own window: the file editor (src/workspace-editor-api.ts), the @ picker (`Mentions.suggest`), the
  whole-app backup, the window's snapshot, conversation export. The rules are about what the assistant sees.
- Walkers of Branch's own or other folders, not the workspace: artifacts, add-on packaging, memory mirror (writes),
  large-output store, migrate importers, plugin scans, security audit, folder trust's item scan (names only, for the
  trust screen), the git shadow checkpoints (data folder), `remote.files` (another computer).
- Fixed configuration folders read by name (`.branch/rules`, schedules, review checks via `markdownFiles`) and `@file`
  imports inside instruction files the owner wrote (src/coding/imports.ts): the owner names those files.
- `workspace.checkpoint` / undo / redo: only the files the assistant itself changed (each write was judged).
- `branch watch <folder> <procedure-id>` (src/cli.ts): held already. It hands the task no file contents, only that
  the folder changed, and the procedure's steps are ordinary tool calls judged one by one (and a walking step is held
  by this branch like any other).

## Found, not fixed
- `code.rename` edits the language server proposes across files are writes, judged by the write path (not this branch).
- `documents.list` and the MCP `documents://library` resource still list a document's name when its file is refused
  (names only, no text).
- `workspace.snapshot` paths are written from the workspace root; with a project folder active, a rule is also weighed
  against the path with that folder in front, which can only leave out more, never less.
- Conversation mode, folder trust and a household role are composed through `Runtime.policy`/`roleRefusal` (the same
  calls `checkPolicy` makes); only the owner's rules, a trigger's task and the active project's folder are tested here.

## Mutation proof (dist/, one change at a time, tests/walk-rules.test.mjs)
Each check taken out of `dist/` on its own, then the file run (24 tests):
- `walkCheck` always allowing: 19 fail. Walk rules not wired (`files.walkRules` always allowing): 18 fail.
- `files.list` entry check: 3 fail. `files.search` read check: 1. code-search folder check: 6; file check: 1.
- Knowledge read-time filter: 1. Summaries filter: 1. Map of names (`passagesAround`): 1. Document library: 1.
- Snapshot: 1. Pull-request hook: 1. AI comments: 1. Language server: 1. Notes folder: 1. Project facts: 1.
The file-level checks inside an allowed folder (search read, grep file, notes file) are only reached by a rule that
refuses reading but not listing; the test "a rule against reading finance (listing allowed)" holds them (it was added
when these three mutations first failed nothing).
Not held by a mutation test: `knowledge-graph` `linksOf` and `build`, the Learn document map, knowledge pictures.

## Merge and final run
- Merged `origin/mac/cross-platform` at `73f73153` (outside-review; no conflicts). `dist/` deleted and rebuilt, the new code
  checked present in `dist/`, `npx tsc --noEmit` clean.
- 34 files at `--test-concurrency=2` (walk-rules, hardening-3, ai-comments, catalog-diet, code-ide, code-tools, coding-next,
  coding-polish, coding-gap-edits, conversation-mode, docs-memory-2, documents, files-paths, folder-trust, handbook,
  history, household-profile, index-structure, knowledge, knowledge-quality, learn, manual-actions-gate, mcp-server,
  never-break-deny, obsidian, outside-review, pr-hook, rag-vector, repo-map, server, shell-ui, static-assets, ui,
  workspace-history): 468 tests, 460 pass, 7 skipped, 1 fail: `tests/server.test.mjs` reported as failed at file level
  with no failing test inside it. My MCP test did not wait for its server to close (`t.after(() => server.close())`);
  made to wait, the same 34 files again: 471 tests, 464 pass, 0 fail, 7 skipped.
- Not merged into trunk (the integrator does that).

## Integration (adversarial review, 2026-09-19)
Integrator: Claude (Opus). Reviewed at `d9cc077e`. Every fix below has a test that was checked to fail with the fix
taken out of `dist/`.

Found and fixed:
- **An owner's yes was overruled by the walk** (blocking). Under "ask before anything under finance", a task's
  `files.list {path: "finance"}` was asked about, the owner said yes, and the retried call failed with "Your settings
  do not allow looking in finance": `WalkRules.start` weighed the same asking rule again and treated it as a refusal.
  Now the rule that asked about the walk's own starting folder counts as answered inside that walk (the walk is
  running, so the question was put and answered yes); any other rule inside still holds (a "never" on
  `finance/q1.txt` still hides that file after the yes). A walk of "." is unchanged: a rule asking about finance still
  leaves it out. `PathCheck` takes the walk's start as a third argument; `WalkRules` remembers its first `start`.
  Test: "integration: a walk of a folder the owner was asked about and said yes to shows what is inside".
- **`documents.list` and the MCP `documents://library` named a refused document** (the builder's "found, not fixed";
  the brief asks to hide it). Both now go through `DocumentLibrary.listFor(owner, outside)`: a document read in from a
  workspace file the rules refuse is not listed, and the tool's answer carries `leftOut`. The owner's own window
  (`view`, the library screen), the morning brief (src/brief.ts) and the terminal place list still use `list` and see
  everything; a pasted document (no file) is always listed. Test: "integration: documents.list and the MCP document
  library do not name a document read from a refused file" (mutations: the filter, and the MCP wiring, each fail it).
- **Merge with mac7/multi-target: a knowledge base of the workspace was refused whole** (blocking, found by the merge).
  multi-target's integration made `knowledge.create` / `knowledge.add` declare a folder source as a whole-folder target
  (`folder: true`), so `innerFolderRule` refused a base of "." under "never anything under finance" — while this
  branch reads that base and leaves finance out. Per the brief (walkers filter; only non-walking tools refuse the whole
  call) the knowledge tools now declare the plain path only: the folder named is still judged (a base of `finance`
  is refused), and what is inside is filtered when the base is read. `tests/multi-target.test.mjs` updated to match.
  Tests: "a knowledge base of the whole workspace made by a task is made, and read without finance" (through a
  model's turn) and a guard, "only tools that do not walk (git) refuse a whole folder; a walker is never a
  whole-folder target", which fails if any tool other than git/plans/github declares `folder: true`.

Checked and left as is (probes run through a model's turn, then removed):
- Paths: `FINANCE`, `notes/../finance`, `./finance/` as a walk's start are refused by the gate; `files.glob
  ["finance/**", "../finance/**"]` and `files.grep {glob: ["finance/**"]}` return nothing plus the note. A junction
  `notes/link -> finance`: a walk from "." skips it (entries that are links are never followed) and a walk starting
  at `notes/link` is refused by `files.checked` ("Symbolic link or junction path denied"). Trailing dots/spaces, `:`
  (drive letters, UNC, streams) and backslashes are refused by `files.checked`. Letter case: rules match either case.
- Windows 8.3 short names (`FINANC~1`): not tested; the multi-target integrator found none generated on this drive.
  If a volume has them, every file tool (not only walkers) would see the long name only after the rules; a general
  gap, not this branch's.
- Names inside a refused folder: never named; the note names the refused folder and only counts files elsewhere.
- No ripgrep or other search program is run: `files.grep` and friends read files in-process (src/code-search.ts);
  no `execFile`/`spawn` of rg/grep/find/findstr anywhere in src.
- Other folder readers found by a sweep of `readdir`/`fs.watch` in src, all outside the workspace or the owner's own
  action: plugin install from a folder the owner names in full (src/plugin-catalog.ts), `branch skill package`
  (src/cli.ts), add-on export (writes), `.branch/rules`/schedules/review checks (fixed names via `markdownFiles`),
  folder trust's note scan (names only, for the trust screen), `branch watch` (prints the changed name to the
  owner's console; the procedure gets no file names), device and USB folders (not the workspace).
- Git: after multi-target, `git.diff {folder: "."}` and `git.status` under "never anything under finance" are refused
  whole ("…because it would read finance"), checked end to end with a real repository whose finance file had a
  change. Pathspec exclusions were **not** added: the gate refuses before git runs, so they would be dead code
  unless the refusal were turned into filtering, which is multi-target's call, not this branch's.
- Performance: the rules are read once per walk (`Runtime.pathCheck`), each folder is weighed once and a folder no
  rule reaches costs nothing (`walkCheck`'s per-folder cache); each file once per walk (`WalkRules`). Not timed here.
- This supersedes one line of STATUS-multi-target.md's Integration: `knowledge.create` / `knowledge.add` with the
  folder "." are no longer refused whole; they are made and read without the refused folder.

### Not proved
- `knowledge-graph` `linksOf`/`build`, the Learn document map and knowledge pictures still have no mutation test of
  their own (the builder's list); `@folder/` mentions and `skills.sync` are covered only through `files.list`.
- The merge commit `b3feda97` carries git's default message without the Co-Authored-By line (not rewritten).

### Merge with trunk and runs
- Waited for mac7/multi-target to land on trunk (`11cb301d`), then merged trunk at `9d54e67a`. One conflict,
  `src/runtime.ts`: this branch's `pathCheck` and multi-target's `everyTarget` sit side by side; both kept whole.
  The knowledge-tools change above was made on a trial merge first and carried over.
- `dist/` deleted and rebuilt, the new code checked present in `dist/`, `npx tsc --noEmit` clean.
- 40 files at `--test-concurrency=2` (walk-rules, multi-target, hardening-2/3, knowledge, knowledge-quality,
  documents, mcp-server, git, code-tools, code-ide, files-paths, docs-memory-2, rag-vector, repo-map, obsidian,
  ai-comments, pr-hook, workspace-history, history, learn, coding-next, coding-polish, coding-gap-edits,
  conversation-mode, folder-trust, household-profile, never-break-deny, manual-actions-gate, outside-review,
  catalog-diet, static-assets, index-structure, handbook, server, ui, shell-ui, approvals, plan-act, leak-guard):
  604 tests, 597 pass, 0 fail, 7 skipped. `tests/automation.test.mjs` alone: 5/5.

- Trunk moved while committing (`26e5b47e`: voice, rooms, trunk conversations; no walker touched): merged again,
  `dist/` rebuilt, tsc clean; walk-rules, multi-target, documents, knowledge, mcp-server, git, hardening-3,
  catalog-diet, static-assets, index-structure, handbook, server, ui, shell-ui: 175/175.

Verdict: MERGE WITH FIXES.
