# mac7/residuals: leftovers reviewers found on 2026-09-19 but did not fix

Branch `mac7/residuals`, from trunk `mac/cross-platform` at d366b45f. Not merged into trunk by this
branch: an integrator reviews it. New tests: `tests/residuals.test.mjs` (server) and `tests/residuals-ui.test.mjs`
(headless window). Existing tests changed for new behaviour: tests/interop-agents, mobile-rules, devices-ui,
p2-shell-ui, delight-ui; tests/panels.test.mjs line 73 marked `not-a-real-secret` (source-hygiene failed on trunk).

## Security / behaviour

- [x] 1. "Do this again" on a task started with a short-lived key carries the key's origin and limits.
  `Runtime.carryOrigin` dropped `originFrom` for anything not from outside, so the copy lost the key's mark.
  It now keeps it when the named task was a short-lived key's: the copy records `shortLivedKey`, its key id is
  read along the chain (only that key may answer its questions), owner-only tools refuse it. Test 1; fails with the line taken out of dist.
- [x] 2. A Trunk task that stops to ask: its message is "waiting for a yes", not failed, and no failure notice is sent.
  `TrunkMessages.finished`: `needs_input` makes the receipt `waiting` (a new status) and sends nothing back. The
  owner answers the question and sends the next message in that Trunk's conversation (that is how a yes carries
  on, public/approvals.js); that task takes the waiting receipt over, and its answer goes back as the reply (or
  its failure as the notice, as before). Only a `message` receipt is taken over, and the oldest waiting one first
  (the owner's answers go oldest first). Test 2 covers both halves and two waiting at once; each line taken out of
  dist fails it (newest-first too).
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
- [x] 4b. `code.run` — decided by the coordinator, done by the integrator: in an Ask first conversation it
  asks every time, Once only (its target is only "a small script", so a kept yes would have covered the next
  one); under Lockdown it is refused; otherwise it follows the scripts permission as before
  (src/runtime.ts `scriptHold`). tests/residuals.test.mjs 4b.
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

- [x] 7. Mode menu and usage list 98% opaque, like the glass dropdown.
  public/layout.css `.mode-menu` (was 95%) and `.usage-pop` (was 88%) now mix the surface at 98%, as `.glass-list`.
  tests/residuals-ui.test.mjs 7 compares the computed colours in light and dark; the old mode menu fails it.
- [x] 8. Achievement names and descriptions in French.
  A server-side French table, src/achievements-fr.ts `inFrench`: words every one of the 505 again from its
  measure and goal (French plurals and numbers, the themes' and pets' names from public/locales/fr.json, "la
  chouette"/"l'écureuil"); the catalogue stays the one source of ids, goals and tiers, and a measure the table
  does not know keeps its English. `GET /api/delight/achievements?lang=fr` (src/delight.ts, src/server.ts);
  public/delight-achievements.js asks in the window's language and asks again when it changes. Tests:
  tests/residuals.test.mjs 8 (every sentence French, same ids/order/tiers, spot checks) and
  tests/residuals-ui.test.mjs 8 (switched to French, the list asks `?lang=fr` and shows "Pousse"); each fails
  with its half taken out. docs/configuration.md says so.
- [x] 9. Room member conversations in Recents; "needs you" banner names the Trunk — already fixed (below).
- [x] 10. Phone app shows the pairing check code.
  While "Lend this phone to Branch" waits, the status line reads "… Check code XXXX XXXX: your computer shows the
  same code beside this phone's request" (en + fr, `phone.device.waitingCheck`). The code is made on the phone from
  its own key (apps/mobile/web/rules.js `keyCheck`, the same SHA-256 as src/devices/protocol.ts), never taken from
  the computer. The page gets the public half through a new native method `deviceKey` (iOS BranchPhonePlugin.swift,
  guarded by `fromAppPage` like the rest; Android BranchPhonePlugin.java + `BranchNode.publicKey()`, which makes
  and keeps the key early so `pair()` reuses it). An older native build without it falls back to the old sentence.
  Test 10 (phone and server codes agree on five keys; the page uses it; both natives offer it);
  tests/mobile-rules.test.mjs method count 18 → 19. **Not proven:** the Java and Swift were not compiled or run
  (no Android SDK or Xcode on this machine).
- [x] 11. Overview and People: bottom padding the height of the floating composer.
  Found: `.shell-page` already had a fixed 96 px (more than today's 65 px ask box), so at the end of the scroll
  nothing was covered (measured at 1440x700 and 390x700); a fixed number stops holding once the box grows.
  Now public/layout.js keeps `--lx-ask-h` at the ask box's real height (ResizeObserver, CSSOM only) and
  `.shell-page` ends with that plus the gap (public/studio.css). While scrolling, a floating box still sits over
  what is under it, as the conversation's box does; padding cannot change that. tests/residuals-ui.test.mjs 11
  (box grown to 180 px at 390 px: room ≥ box, last line above it, both pages); the old 96 px fails it.
- [x] 12. Trunks strip switched off: first paint uses the last known switch value. **Already on trunk, untested.**
  public/strip.js (edb3a4b4, p2-shell integration) keeps the last switch value in `localStorage["branch-strip"]` and
  `reserveRoom` takes no room when it says off. A truly brand-new browser has nothing remembered, so it still
  reserves the room until the first answer; nothing local can know better. Added the missing test:
  tests/residuals-ui.test.mjs 12 (switched off, reloaded: the strip's element and class never appear, watched from
  before the page's own scripts); taking out the `remembered()` line fails it.
- [x] 13. Pairing: "Let it in" only after the owner ticks "The code matches".
  Both desktop places that let a device in: the studio's Let it in step (public/pairing.js `codesMatch`) and the
  Devices card's waiting row (public/devices.js `matchBox`, the tick kept across its 5-second redraw). Only when
  the request carries a check code; en + fr "The code matches". The route is unchanged (the CLI approval still
  works). tests/devices-ui.test.mjs and tests/p2-shell-ui.test.mjs now assert the button is disabled, tick, then
  let it in; taking out either disabling line fails its test.
- [x] 14. Read-aloud: a headless test that a spoken reply plays (blob: src, no CSP violation).
  tests/residuals-ui.test.mjs 14: a real reply, its "Read aloud" button, the voice service stood in by a quarter
  second of silent WAV (`/api/voice/speak` routed); the window's audio gets a `blob:` src, no media-src/default-src
  refusal, and plays to `ended`. Taking `blob:` out of `media-src` in dist/server.js fails it. (The same run sees the
  settings kit's inline-style refusals, the item left to the settings integrator; the test ignores those.)
- [x] 15. Own background: switching off keeps the file; a separate "Remove picture" deletes it (with a confirm).
  public/delight-background.js: off only takes it down (`clear`); `forgetBackground` removes the window's
  IndexedDB database; `savedBackground` looks with `indexedDB.databases()` first, so painting the card never makes
  storage for somebody who never chose a file. public/delight.js: the kept file's name and "Remove picture" sit
  outside the part that needs it on, so they show while it is off; the button asks first (`confirm`, "It cannot be
  brought back"). en + fr; the card's note and docs/configuration.md say so. tests/delight-ui.test.mjs "your own
  background: … switching off keeps the file, Remove picture (after a yes)…" replaces the old "switching off
  removes" test; forgetting on off, or no confirm, each fails it.
- [x] 16. `branch-everything-hidden` wired from the hide feature — already fixed (below).
- [x] 17. Merge latest trunk, rebuild, retest, push. Merged origin/mac/cross-platform at 2674e2ae (p2-settings; clean),
  dist deleted and rebuilt, tsc clean. 54 files at --test-concurrency=2: 765 tests, 749 pass, 2 fail, 14 skipped.
  The two failures are trunk's own, not this branch's: source-hygiene flagged tests/panels.test.mjs:73 (fixed here
  with the `not-a-real-secret` marker), and tests/panels.test.mjs "hiding everything earns It's lonely over here"
  times out waiting for `#panels-float-gear` — it fails the same way on a clean checkout of trunk 2674e2ae (passes
  when run alone with a name filter), so it comes from the p2-settings / p2-panels meeting, left for their owners.
- [x] 18. (added by the coordinator) In French, Settings search named a setting whose control is not drawn yet in
  English. public/i18n.js `fromEnglish` finds the locale key whose English is exactly those words and gives the
  chosen language's; public/settings-grown.js falls back to it for a row's label and its card's title after the
  drawn words. 432 of the 550 index labels and 543 of 550 card titles have such a key; the rest stay English (mostly
  service names such as IRC or Mastodon, the same in French). tests/residuals-ui.test.mjs 18 (a row not drawn yet,
  searched in French, shows the French name); without the fallback it fails.

Left alone on purpose: settings-describe.js / settings-kit.js inline `<style>` (the p2-settings integrator is changing the settings files now).

## Already fixed on trunk (evidence)

- 9. Recents: `src/index.ts:1079` sets `store.hiddenSessions` from `trunks.rooms.memberConversations()`,
  `src/store.ts` applies it to search and recents; `tests/p2-rooms.test.mjs` "integration review: a room's
  inner conversations stay out of Recents". Banner: `attention.trunkNeedsYouInRoom` ("{name} needs you in
  {room}", en + fr), asserted by `tests/p2-rooms-ui.test.mjs` (/Ledger needs you/). Fixed by the p2-rooms integrator.
- 16. `public/panels-hide.js` dispatches `branch-everything-hidden` once every part is hidden,
  `public/delight.js` listens; `tests/panels.test.mjs` counts the event (0 while one part shows, then 1).
  Fixed by the p2-panels integrator.

## Integration (2026-09-19, adversarial integrator)

Verdict: **MERGE WITH FIXES** (fixes below, already applied in 50e9339a and the commit after it).

Fixed here:
- **2 was a mis-route.** Any next task in the Trunk's conversation (the owner's unrelated question, a
  chat app's message) took the oldest waiting receipt, and its answer went to the sending Trunk. Now a
  waiting message is taken over only after the owner presses **Answer** on its card at the top of the
  window ("Ben is waiting for your answer", "About Ann's message: “…”", Answer / Not now); never by a
  task marked `source: "channel"` or `shortLivedKey`. **Not now** ends it and tells the sender.
  Owner-only routes `POST /api/trunks/messages/<id>/answer|decline` (short-lived keys refused by the
  route table; household refused by `requireOwner`). State field `trunkWaiting` (owner only, never a key).
  Tests: residuals 2 (unrelated message not taken, chat/key not taken, chosen one of two, Not now),
  2 (routes), residuals-ui 2 (integration).
- **13 held only in the window.** `POST /api/devices/requests/<id>` with `approve: true` now needs
  `codeMatches: true` (400 otherwise); both window callers send the tick; p2-shell asserts the 400,
  p2-shell-ui ticks with the keyboard (focus + Space). Documented in docs/configuration.md.
- **4b** implemented as decided (above). **4a** verified: an Ask first conversation asks for a listed
  program no rule mentions (new assertion); Full access still lets it start.
- **3**: restart test added (A2A, ACP and the app-server each carry on their own conversation after the
  app is closed and opened again). Error codes documented: A2A `-32602`, ACP `-32000`, app-server `-32600`.
  Note: any A2A caller with the key may carry on any A2A-begun conversation (the agent name is
  self-declared), and ACP and app-server share the "acp" source; both documented, not changed.
- panels.test.mjs:73 marker made identical to ci-flakes-3's, so the two merge without a conflict.

Remove-fix spot checks (dist edited, test failed, restored): 4e, 4d, 4a `listed`, 4c, 2 `needs_input`.
Others (5, 7, 8, 11, 12, 14, 15, 18) taken on the builder's word, their tests passed.
Item 10 is PARTIAL: the Swift and Java were read (the key is made once and reused by pairing) but not compiled.

Runs: 58 files at --test-concurrency=2: 737 tests, 730 pass, 1 fail, 6 skipped. The one failure is
trunk's own "hiding everything earns It's lonely over here" (fails the same on trunk 2674e2ae under
load; passes alone). tests/automation.test.mjs alone: 5/5.
