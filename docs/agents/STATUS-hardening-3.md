# mac7/hardening-3 — status

Builder: Claude (Opus), 2026-09-19. Branch `mac7/hardening-3` from trunk `cc212bf5`. Tests: `tests/hardening-3.test.mjs`.
Every fix has a test that was checked to fail with the fix taken out of `dist/` (noted per item).

- [x] 1. Permission rules see what the tool uses
- [x] 2. Loop guard compares cleaned arguments
- [ ] 3. Hung local model: one retry, capped first-reply wait, plain message
- [ ] 4. `code.rename` held to read-before-edit
- [ ] 5. Malware check: over 10 pages is "not checked", not clean
- [ ] 6. Monthly spend includes a video still being made
- [ ] 7. Docker: `BRANCH_BIND`
- [ ] 8. `/account` notice shows the connection's name
- [ ] 9. `accounts viewAll`: a household person sees only their own accounts
- [ ] Merge latest `origin/mac/cross-platform`, rebuild, retest, push

## 1. Permission rules see what the tool uses

**What the brief said vs what was there.** The premise "non-strict schemas silently drop extra keys" does not
reproduce for Branch's own tools: every built-in tool schema is `.strict()` (checked on a running app, 213 tools,
with `z.toJSONSchema(..., { io: "input" })`; the one apparent exception, `agents.remote`, is a
`discriminatedUnion` of strict objects), and since mac7/coding-next `ToolRegistry.clean()` drops the unknown key
before the policy looks. The real hole was the other half of the brief: **what the policy read was the arguments
as sent, not as parsed**. `clean()` hands back its input, never `parsed.data`, so a schema that maps a name
(`files.edit` takes `file_path` for `path` through `z.preprocess`), trims text or fills a default ran with arguments
the rules never saw. `files.edit {file_path: "finance/q1.txt", …}` had target `""`, so "Never allow anything under
finance" did not match, and the edit was made.

**Fix.** One shared derivation, used by every layer:
- `ToolRegistry.runArgs(name, args)` (src/registry.ts): the tool's own schema applied (`safeParse(...).data`); the
  call as sent when it does not parse (it is then refused by the tool anyway).
- `ToolRegistry.targetOf` reads `runArgs` before the tool's own `target()` or `policyTarget` — so every caller of
  `targetOf` (runtime, playground, MCP dry run, sandbox wall) gets it.
- `Runtime.prepareCall` (src/runtime.ts) reads a model's call once: `args` (cleaned; handed to the tool, which parses
  it with the same schema) and `seen` (= `runArgs`; handed to the file note, the label, `gate` → `checkPolicy` →
  `resourceOf`/`protectedTarget`/leak guard/personal hold, the second-model reviewer, the approval card bytes, the
  wall, the failed-command note, the troubleshooter).
- `Runtime.checkPolicy` and `Runtime.wallFor` apply `runArgs` themselves, so every other caller (workflows, flows,
  procedures, the MCP server, realtime voice, web pages, never-break resume, tool-gate's manual actions) is covered.
- `playground` ("Try a tool") and `mcp-policy.dryRunPlan` judge `runArgs`; the dry run now also passes the
  `resource`, so a folder rule is weighed there as it is when the call runs (it said "ask" where the call is refused).
- Tools whose file is not under `path`/`url` got their own `target()`: `documents.analyse` and `documents.compare`
  (`file`), `knowledge.add` (`source.path`).
- Kept: the approval fingerprint is the exact bytes sent (coding-next's choice: a yes can only get narrower). The
  card now shows the call as it will run (mapped names, defaults) whenever that differs from what was sent.

Tests (`tests/hardening-3.test.mjs` "1 …"): `runArgs` unit; `files.edit` via `file_path` into `finance/` refused and
the file unchanged; `documents.analyse` with `file: finance/…` refused; `knowledge.add` target; the question's target
and bytes show `path` while the fingerprint stays that of what was sent; MCP dry run target and decision.
Proved: with `runArgs` returning its input and the two `target()`s removed in `dist/`, all five "1 …" tests fail.

### Every tool checked (331 names: 213 from a running app, the rest from the source)
Grouped by where the thing a rule is about comes from. "own" = the tool's `target()`, now fed parsed arguments.

- **Own `target()` (70):** agents.ask, blocks.list, blocks.run, browser.act, browser.borrow, browser.click, browser.fill,
  browser.tab, browser.upload, chat.send_file, code.change_set, code.patch, code.rename, code.run, computer.look,
  computer.press, computer.type, debug.start, desktop.click, desktop.clipboard, desktop.key, desktop.open, desktop.read,
  desktop.screenshot, desktop.type, desktop.windows, git.worktree_add, git.worktree_remove, github.publish_repo,
  home.call, home.states, machines.look, media.captions, media.compare, media.convert, media.download, media.image,
  media.speak, media.trim, models.switch, nodes.ask, plans.merge, plans.try, process.start, project.assign,
  project.board, project.init, remote.files, remote.list, remote.read, remote.run, research.article,
  screen.background, shell.session.open, shell.session.run, skills.bundle.preview, skills.sync,
  tools.forget_service, tools.from_openapi, troubleshoot.run, trunk.message, trunks.remote.message, video.generate,
  voice.say, wasm.run, web.crawl, web.page, workspace.checkpoint, workspace.redo, workspace.undo; plus, new here,
  documents.analyse, documents.compare, knowledge.add.
- **`path` / `url` read by `policyTarget` (40):** artifacts.keep, artifacts.restore, assistant.market, browser.navigate,
  code.definition, code.diagnostics, code.format, code.hover, code.map, code.references, data.export, data.load,
  documents.add, documents.edit, documents.write, files.edit (was bypassable via `file_path`; fixed), files.glob,
  files.grep, files.history, files.list, files.read, files.search, files.validate, files.verify, files.write, git.log,
  install.request, knowledge.pictures, knowledge.remove, media.describe, media.frames, media.info, media.transcribe,
  media.watch, monitor.create, notebook.read, rules.for_path, sdk.route, web.fetch, workspace.map.
- **Commands and messages (`policyTarget` / `resourceOf` by tool name):** shell.execute, shell.session.run/open,
  remote.run, channels.*, email.* — now read from parsed arguments.
- **Other path-like keys, looked at:** context.read (`file` is one of the owner's instruction-file slots, not a
  workspace path); git.branch/commit/diff/status/worktree_list, plans.diff (`folder` is the repository, judged by the
  git permissions, unchanged); labels.* (`target` is a label target id); history.meaning, learning.journey,
  memory.find, notebook.read (`from`/`to` are dates or cell numbers); memory.put/update, sources.sync, research.run,
  answer.page (`source(s)` are names or citations, not files); tools.script (`source` is code, judged as code.execute);
  board.card_handoff, channels.broadcast, conversation.handoff (`to` is a person, channel or agent); flow.search (`save`
  is a switch).
- **Nothing a path/site/command rule is about (194):** memory, todos, schedules, workflows, specialists, delegate,
  knowledge search/ask, browser reads of the current page, brief, boards, procedures, status and list tools, etc.
  (full list in the builder's scratch audit; each has no key naming a file, site or command).
- **Outside tools (MCP servers, plugins, skill HTTP tools, OpenAPI tools):** `z.record` or generated strict schemas;
  `clean()` skips `z.record` by design and the outside server judges its own arguments. `runArgs` returns the same record.

**Found, not fixed (single-target policy, pre-existing, larger than this pass):** a rule sees one target per call, so
`documents.compare`'s `against`, `documents.edit`'s `saveAs` (the file written when set), `knowledge.create`'s
`sources[]`, and the "N files: a, b" target of `code.patch`/`code.change_set` are not matched by a folder rule;
`files.patch` has no target at all (its paths are inside the patch text). Judging every path a call names needs
`target()` to return a list and `checkPolicy` to take the strictest answer; recommended as its own piece of work.

## 2. Loop guard compares cleaned arguments
- The runtime's round loop now calls `prepareCall` first and hands the loop guard the call as the tool will run it
  (`seenText`: cleaned of unknown keys, parsed, defaults filled); the tool call itself takes the same prepared call,
  so it is read once. `canonicalArguments` still sorts keys.
- Test "2 …": eight `files.read` calls that only change a junk key are warned about and then refused (loop guard on).
  Proved: with the guard handed `call` again in `dist/runtime.js`, the test fails.
