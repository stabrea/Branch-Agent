# Redesign phase 1: status

Branch `mac7/redesign-phase1`, worktree `C:/Users/bishi/Code/wt/redesign-phase1` (Legion; earlier `/Volumes/512GB SSD/branch-wt/redesign-phase1` on the Mac), cut from
`mac/cross-platform` at 926eb454 (0.18.1). Not merged: an integrator merges it.

Design sample: `~/Library/Caches/claude-session-files/branch-grown-up/index.html` (parts in `parts/`),
owner critiques in `OWNER-CRITIQUES.md` there (#17/#31 usage ring, #42 95% prompt, #43/#28 suggestion
bars and update cards, #56 Slate, #20 mode picker, #29 glass dropdowns and tooltips).

## Pieces

| # | Piece | State |
|---|---|---|
| 1 | Usage ring + "What each connection has left" popover; 95% save-progress prompt | [x] done: src/usage-glance.ts, GET /api/usage/glance (non-owner: `{available:false}`), POST /api/usage/save-progress (steers running tasks), settings ring/saveProgress on the Usage screen; public/usage-glance.js; tests in tests/redesign-phase1.test.mjs |
| 2 | Suggestion bars (background, updates), quit-while-needed warning, Updates choice cards | [x] done: src/suggestions.ts + GET/POST /api/deployment/suggestion; public/suggestions.js (floats at the top of the pane); Updates choice cards in public/comfort.js; src/desktop/quit-guard.ts wired in src/desktop/main.ts before-quit (desktop not run: logic unit-tested only); tests/suggestions.test.mjs, tests/quit-guard.test.mjs |
| 3 | Default theme Slate | [x] done: default slate (window, terminal, phone fallbacks); a picked theme is always written down; a Forest the shared record holds is adopted by a window with no choice of its own; tests in tests/redesign-phase1.test.mjs |
| 4 | Permission-mode chip in the composer | [x] done: src/conversation-mode.ts (+ -api.ts), enforced in runtime.policy(source, runId) before the outside hold; /api/conversation-mode(/settings); POST /api/run `mode`; public/conversation-mode.js; tests/conversation-mode.test.mjs. New owner setting `newConversation` (ask/follow); UI tests about other things set it to follow |
| 5 | Glass dropdown replacing native selects; icon-button tooltips | [x] done: public/glass-select.js dresses every single-choice select (static and later-drawn; the native select stays the source of truth), glass listbox via public/popover.js trackPopover; glass tooltips for icon-only buttons; tests/glass-select.test.mjs. No select skipped |

## How to continue

- `npm run build`, `npx tsc --noEmit`, `node --test --test-concurrency=2 <explicit files>`.
- Never run tests/desktop*.test.mjs or tests/screen-control.test.mjs on the Mac.
- `dashboard-card.js` stays directly before `layout.js` in public/index.html.

## State at hand-over (2026-09-19, Legion)

- All five pieces built; `origin/mac/cross-platform` merged in at 2e6aa010 (no conflicts). Not merged into trunk.
- Run on the merged commit in a separate checkout: 650 tests across every `*ui*` file (desktop excluded) and the
  policy, household, short-lived-key, comfort, terminal, mobile, usage and new-piece suites: 645 pass, 0 fail, 5 skipped.
- Not run (they open windows on the owner's PC): tests/desktop*.test.mjs. Three of them send a message whose
  practice run writes a file; they now switch `newConversation` to `follow` first (like the other UI tests that are
  about something else). Please run them on a machine where windows may open.
- Proof pictures: `C:/Users/bishi/AppData/Local/Temp/claude-session-files/branch/redesign-shots/` (made by
  `claude-session-files/branch/rp1/shots.mjs <worktree> <scene...>`).
- Behaviour changes to know about: a conversation begun in the window starts on Ask first (owner setting
  `newConversation` ask/follow under When to check with me); the update suggestion bar shows once per launch in any
  onboarded window until answered (tests that are about something else may need `POST /api/deployment/suggestion
  {id, answer: "never"}`); every select is dressed as a glass list (native select kept, so `selectOption` works).


## Integration (adversarial review, Claude, 2026-09-19)

Reviewed f15d4acd merged with trunk cc212bf5 (mac7/coding-next is on trunk; one conflict in `src/desktop/main.ts`,
the quit guard beside coding-next's `startCrashReporter`, both kept). Fixes in 0ed18dcd. Verdict: **MERGE WITH FIXES** (applied).
Every new security test was checked to fail with its fix taken out of `dist/`.

Fixed (tests in the named files, each marked "integration review"):
- [x] **Blocking: helpers escaped the mode.** A helper or background specialist runs in a new conversation of its own,
  so it was held to the owner's global setting: an Ask first conversation on "No approvals" let its helper write
  without asking. The runtime now walks up to the nearest parent conversation with a mode (`conversationModeOf`,
  src/runtime.ts). tests/conversation-mode.test.mjs.
- [x] **Blocking: short-lived keys got Full access.** The runtime only kept household people to the owner's setting;
  a short-lived key's task in a Full access conversation (or a task started or resumed from outside) got Full access.
  Now only the owner's own task (no household person, no key, source owner along the chain via `runOrigin`) may have a
  mode looser than the setting (`ownersOwnTask`).
- [x] **`POST /api/run` `mode` was not checked:** a household person, a key or anyone under Lockdown could start a Full
  access conversation. It is now refused (403) with the chip's own reason (`modeRefusal`).
- [x] **Quit:** macOS/Linux shutdown (`powerMonitor` "shutdown") and Windows session end mark the quit as the system's,
  so it never asks; before-quit no longer swallows an update / `branch quit` / shutdown that arrives while the question
  is showing. tests/quit-guard.test.mjs (read-only source checks; the desktop was not run).
- [x] **Glass list:** flush under the select (was 4 px down with a 3 px slide, which showed half a line of the help
  under it) and 98% opaque; a list whose options change while open closes rather than picking by a stale index;
  pressing a greyed option keeps the keyboard in place. tests/glass-select.test.mjs (groups, greyed, one change event,
  FormData value, dynamic list, 1440 and 390).
- [x] **Usage ring list** opened over the text field at 390x844 and 1024x700; it now opens under the ring when there is
  room, else above the message box. tests/redesign-phase1.test.mjs.
- [x] **Background suggestion** said "now keeps running" when the install failed; it now says it could not, and why.
  tests/suggestions.test.mjs.
- [x] **Plain words (en + fr):** "Use my setting — Currently: No approvals."; "Asked the running task …" /
  "Asked N running tasks …"; the usage summary ("Your one connection reports a limit.", "1 of 3 connections reports a
  limit. The other 2 …"). Ask first's note said it asks before "using the internet", but reading the web is free under
  it (it is Ask before changes); now "acting on web pages. Reading and looking things up are free". Auto's note said
  it asks before "anything else"; it does not (Just do it inside my workspace allows what it does not list); fixed.
  The owner's sample used the old words, so the owner may want to see these two.
- [x] **Tests question (coding-next) per mode**, tested: Plan refuses `code.check` as a change (never runs, never asks;
  refusal rather than a dry run, since Plan refuses changes), Ask first asks, Auto and Full access still ask the
  project-tests question once per folder; a plain yes is Once and writes no rule; Always writes the folder rule. The
  mode chip answers no questions, so nothing here can give Always.

Checked and fine: Lockdown greys Auto/Full and `policyForMode(locked)` keeps Lockdown's rules; Plan keeps the owner's
refusals and drops every yes; agreeing a plan (owner-scoped run route) moves Plan to Ask first only after the answer lands; a mode switch applies at the next tool call (tested); a household person cannot pick a
mode for the owner's conversation (404, tested); chat-app/trigger/schedule/MCP/A2A/ACP tasks joining a Plan conversation
are refused, not asked (tested); `/api/usage/glance` gives others `{available:false}`, money is never a share; Slate:
a picked theme is always written down, a Forest the shared record holds is adopted, dark mode untouched, terminal
default follows `DEFAULT_THEME`; static allowlist, index order, docs entries present.

Per piece: 1 VERIFIED (after fixes), 2 VERIFIED except the Electron wiring (read, not run), 3 VERIFIED,
4 VERIFIED (after the three blocking fixes), 5 VERIFIED (after fixes).

Notes, not fixed:
- The MCP tool list, dry-run text and resource list (src/mcp-policy.ts, `mayRead` in src/mcp-server.ts) are worked out
  from the owner's setting, not a conversation's mode: they belong to no conversation. The real call is judged with
  the mode. Documented in docs/configuration.md. (The builder's "Plan over MCP asks" note was about these, and was
  overstated.)
- Resuming a task started from a schedule, trigger, MCP or A2A resumes it with source "owner" (only chat is carried);
  pre-existing. The mode can no longer be loosened for it, but the 0.18.1 cap on its own call source is lost on resume.
- The mode menu and the usage list use see-through glass (88%); text behind shows faintly. Not a bug; the owner may
  want them as opaque as the select list.
- Letter tiles instead of provider logos (phase 2, as decided).
- Screenshots: `redesign-shots/*-fixed.png` (dropdown, ring-open incl. 1024x700, mode-open, save-progress).
