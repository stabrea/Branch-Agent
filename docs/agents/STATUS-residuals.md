# mac7/residuals: leftovers reviewers found on 2026-09-19 but did not fix

Branch `mac7/residuals`, from trunk `mac/cross-platform` at d366b45f. Not merged into trunk by this
branch: an integrator reviews it. Every new test is in `tests/residuals.test.mjs` unless noted.

## Security / behaviour

- [ ] 1. "Do this again" on a task started with a short-lived key carries the key's origin and limits.
- [ ] 2. A Trunk task that stops to ask: its message is "waiting for a yes", not failed, and no failure notice is sent.
- [ ] 3. A2A / ACP / app-server may only continue conversations they started; otherwise refused in plain words.
- [ ] 4a. `process.start` arguments judged by command rules like a shell command.
- [ ] 4b. `code.run` judged only by its permission.
- [ ] 4c. `mail.save_attachment` declares its file target.
- [ ] 4d. Older match-style rules: the target is path-tidied before matching.
- [ ] 4e. In-flight spend counts every still-running task, whatever month it began.
- [ ] 5. ChatGPT single sign-in: a plain warning in the fallback settings when the order holds a Codex program.
- [ ] 6. Coding-next notes (hung local model, read-set after 500 tasks, short names / case).

## UI / polish

- [ ] 7. Mode menu and usage list 98% opaque, like the glass dropdown.
- [ ] 8. Achievement names and descriptions in French.
- [x] 9. Room member conversations in Recents; "needs you" banner names the Trunk — already fixed (below).
- [ ] 10. Phone app shows the pairing check code.
- [ ] 11. Overview and People: bottom padding the height of the floating composer.
- [ ] 12. Trunks strip switched off: first paint uses the last known switch value.
- [ ] 13. Pairing: "Let it in" only after the owner ticks "The code matches".
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
