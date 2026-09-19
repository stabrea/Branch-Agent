# mac7/residuals: leftovers reviewers found on 2026-09-19 but did not fix

Branch `mac7/residuals`, from trunk `mac/cross-platform` at d366b45f. Not merged into trunk by this
branch: an integrator reviews it. Every new test is in `tests/residuals.test.mjs` unless noted.

## Security / behaviour

- [x] 1. "Do this again" on a task started with a short-lived key carries the key's origin and limits.
  `Runtime.carryOrigin` dropped `originFrom` for anything not from outside, so the copy lost the key's mark.
  It now keeps it when the named task was a short-lived key's: the copy records `shortLivedKey`, its key id is
  read along the chain (only that key may answer its questions), owner-only tools refuse it. Test 1; fails with the line taken out of dist.
- [x] 2. A Trunk task that stops to ask: its message is "waiting for a yes", not failed, and no failure notice is sent.
  `TrunkMessages.finished`: `needs_input` makes the receipt `waiting` (a new status) and sends nothing back. The
  owner answers the question and sends the next message in that Trunk's conversation (that is how a yes carries
  on, public/approvals.js); that task takes the waiting receipt over, and its answer goes back as the reply (or
  its failure as the notice, as before). Test 2 covers both halves; each fails with its line taken out of dist.
- [x] 3. A2A / ACP / app-server may only continue conversations they started; otherwise refused in plain words.
  `conversationBegunBy` (src/outside-origin.ts): the source of a conversation's first task (the row's own
  source for ACP/app-server openings, else its `run.started`). A2A `sessionFor` (now checked in `begin`, before
  a stream opens), ACP `session/prompt` and app-server `turn/start` refuse anything not begun by them with
  "Another program can only carry on a conversation it started itself…"; an unknown A2A id reads the same (it
  used to start fresh, which also told a caller which ids were real). The Agent Protocol already only carries on
  the conversation its own task record holds (src/interop/agent-protocol.ts `runStep`), unchanged. No "shared with
  a program" mechanism exists, so none is honoured. tests/interop-agents.test.mjs "a streamed task that never
  starts" now seeds an A2A conversation. Test 3; each of the three checks fails it when taken out.
- [x] 4a. `process.start` arguments judged by command rules like a shell command.
  Decision: command rules read the **resolved** command, not the short name: a tool may now say which command it
  runs (`ToolDefinition.command`, used by `ToolRegistry.resourceOf`); `process.start` gives the listed program
  by its own name (no folder, no .exe/.cmd — a folder with spaces would break the word split), its listed
  arguments, then the call's (`BackgroundProcesses.commandLine`). So "never npm install" holds whatever the owner
  named it. The target (card text, remembered yes, legacy `match`) stays "shortname args", unchanged. Such a
  command is marked `listed`: with no rule about it, it goes ahead as before (the program is on the owner's own
  list) instead of getting the unknown-command question, so nothing changes for existing users without a rule.
  Test 4a; taking out the `command` hook or the `listed` exemption each fails it. 212 process/policy tests pass.
- [ ] 4b. `code.run` judged only by its permission. **Not changed (no decision given; a design question).**
  Its "target" is a script, not a path or a command: no folder or command rule can say what a script will do.
  It is held by a rule on `code.run` / `code.execute`, the job limits, and the wall when that is on
  (src/sandbox-wall.ts `walledTools`). Judging it by a folder rule would need the script run inside a
  deny-aware sandbox; left for the owner to decide.
- [x] 4c. `mail.save_attachment` declares its file target.
  Its target is the owner's attachments folder (`mail.settings().folder`), so a folder rule ("never under finance")
  judges it. The file's own name is known only after the message is fetched, so a rule on a file name or type
  cannot see it (said in the code). Test 4c; taking the target out fails it.
- [x] 4d. Older match-style rules: the target is path-tidied before matching.
  src/policy.ts `matchesTarget`: the raw glob first (unchanged), then, when the call is about a file, the rule's
  `match` and the target both through `tidyPath`, and the target inside the active project folder
  (`inWorkspace`). A `*` rule is not re-read. Test 4d ("././finance/q1.txt", "finance\\q1.txt",
  "notes/../finance/q1.txt", "finance//q1.txt", "q1.txt" in the finance project); the old one-line check fails it.
  policy suites (hardening 1-3, multi-target, tool-safety, walk-rules, outside hold): 152/152.
- [x] 4e. In-flight spend counts every still-running task, whatever month it began.
  `UsageStore.inFlightSpend` no longer filters on `created_at` (running or waiting for a person, as before).
  Test 4e (a task dated 40 days back); putting the month filter back fails it.
- [x] 5. ChatGPT single sign-in: a plain warning in the fallback settings when the order holds a Codex program.
  Settings → Models, under "If the default fails, try these in order": `#models-fallback-codex` (en + fr) shows
  while a ticked connection is a Codex program (`cli-agent:codex` or `app-server:codex`) and a ChatGPT sign-in
  (`chatgpt`) is configured; it follows the boxes as they are ticked. Behaviour unchanged. (public/app.js
  `codexFallbackNote`, public/index.html; not a settings*.js file.) tests/residuals-ui.test.mjs 5; always-hidden fails it.
- [ ] 6. Coding-next notes (hung local model, read-set after 500 tasks, short names / case). **Not changed (notes, all
  fail closed; no decision given).** A hung local model still ends (300 s + grace, then the fallback or the plain
  sentence); a read-set dropped after 500 tasks or a short/differently-cased name only asks the task to read the
  file again before editing (the safe side). Changing any of them trades memory or a timeout the reviewers accepted.

## UI / polish

- [ ] 7. Mode menu and usage list 98% opaque, like the glass dropdown.
- [ ] 8. Achievement names and descriptions in French.
- [x] 9. Room member conversations in Recents; "needs you" banner names the Trunk — already fixed (below).
- [ ] 10. Phone app shows the pairing check code.
- [ ] 11. Overview and People: bottom padding the height of the floating composer.
- [ ] 12. Trunks strip switched off: first paint uses the last known switch value.
- [x] 13. Pairing: "Let it in" only after the owner ticks "The code matches".
  Both desktop places that let a device in: the studio's Let it in step (public/pairing.js `codesMatch`) and the
  Devices card's waiting row (public/devices.js `matchBox`, the tick kept across its 5-second redraw). Only when
  the request carries a check code; en + fr "The code matches". The route is unchanged (the CLI approval still
  works). tests/devices-ui.test.mjs and tests/p2-shell-ui.test.mjs now assert the button is disabled, tick, then
  let it in; taking out either disabling line fails its test.
- [ ] 14. Read-aloud: a headless test that a spoken reply plays (blob: src, no CSP violation).
- [ ] 15. Own background: switching off keeps the file; a separate "Remove picture" deletes it (with a confirm).
- [x] 16. `branch-everything-hidden` wired from the hide feature — already fixed (below).
- [ ] 17. Merge latest trunk, rebuild, retest, push.

Left alone on purpose: settings-describe.js / settings-kit.js inline `<style>` (the p2-settings integrator is changing the settings files now).

## Already fixed on trunk (evidence)

- 9. Recents: `src/index.ts:1079` sets `store.hiddenSessions` from `trunks.rooms.memberConversations()`,
  `src/store.ts` applies it to search and recents; `tests/p2-rooms.test.mjs` "integration review: a room's
  inner conversations stay out of Recents". Banner: `attention.trunkNeedsYouInRoom` ("{name} needs you in
  {room}", en + fr), asserted by `tests/p2-rooms-ui.test.mjs` (/Ledger needs you/). Fixed by the p2-rooms integrator.
- 16. `public/panels-hide.js` dispatches `branch-everything-hidden` once every part is hidden,
  `public/delight.js` listens; `tests/panels.test.mjs` counts the event (0 while one part shows, then 1).
  Fixed by the p2-panels integrator.
