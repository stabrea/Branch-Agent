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
- **Git tools reading the working tree** (`git.status`/`git.diff` on "."): mac7/multi-target (not merged yet) judges
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
  with no failing test inside it; run again alone 4/4 and with static-assets, index-structure and handbook 18/18.
- Not merged into trunk (the integrator does that).
