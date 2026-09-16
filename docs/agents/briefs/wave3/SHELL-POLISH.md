# Wave 3 task: shell polish after the second pass (0.10.0)

Rules: docs/agents/briefs/wave1/BUILD.md and the design constraints in wave2/REDESIGN.md and wave2/REDESIGN-2.md. Branch: wave3/shell-polish from the local branch wave2/integration. Scope: public/shell.css, public/shell.js, public/context-pane.js, public/index.html, public/app.js (small), docs/design.md. Other builders are adding small settings cards elsewhere; keep your edits inside the shell files.

Observed in the packaged 0.10.0 (screenshot C:/Users/bishi/AppData/Local/Temp/claude-session-files/branch-walkthrough/out/01-home.png and the wave2-shell-2 after-*.png set):
1. The floating composer covers content: on first run the "What would you like to do?" greeting and the "Saved conversations" row sit under the composer. Give the message column bottom padding equal to the composer's height (measure with ResizeObserver, set a CSS variable), and make the first-run "Choose how your assistant thinks" panel and the greeting live inside the scrolling column above that padding.
2. The Send button wraps its label onto two lines ("Send / ↗"). Make it a single-line pill with `white-space: nowrap` and a fixed min width; icon after the text.
3. The composer's helper text ("New conversation · tools leave a record") competes with the buttons; move it to a quiet line under the composer.
4. First-run: the "Choose how your assistant thinks" panel should read as a welcome card with the three choices as equal tiles and one primary action, consistent with the new flat style (no heavy copper bottom borders on the tiles; use the token ring for focus/selection).
5. Rail: the Sections group should remember collapsed state per owner (it already remembers folding; verify) and show a subtle count badge for Activity when tasks are running; Recents rows need a hover background in Daylight (currently invisible).
6. Context pane: when nothing is connected, show one clear primary action ("Connect a model") instead of a disabled-looking box; the acorn should not push content when the pane is short (min-height/flex).
7. Keyboard: Tab order should go rail → title bar → messages → composer; Esc from the composer clears focus, not the draft; Ctrl+Shift+K toggles the context pane.
8. Verify at 1280×800, 1024×700 and 400×800 in both themes; no horizontal scroll; screenshots to C:/Users/bishi/AppData/Local/Temp/claude-session-files/wave3-shell-polish/ named after-<theme>-<state>-<w>x<h>.png including the first-run state and an empty conversation state.

Tests: extend tests/shell-ui.test.mjs — composer never overlaps the greeting (bounding boxes do not intersect), Send label is one line, Recents hover background differs from the rest in Daylight (computed style), Ctrl+Shift+K toggles the pane, Tab order for the first five stops. All existing UI tests stay green; desktop tests are not run.

Acceptance: S1 no overlap proven; S2 Send single-line; S3 first-run card restyled (screenshot); S4 context pane primary action; S5 keyboard items; S6 screenshots delivered; S7 no new colours outside tokens.css (grep proof).
