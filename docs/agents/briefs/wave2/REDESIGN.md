# Wave 2, task 1: the app shell redesign (navigation + appearance)

Read docs/agents/briefs/wave1/BUILD.md first (same rules: worktree, tests, plain language, no dependencies, small edits to shared files, Conventional Commit with the Co-Authored-By line). Branch: wave2/shell. Base: the current feat/assistant-runtime (run `git fetch origin && git checkout -b wave2/shell origin/feat/assistant-runtime`).

## What the owner said (verbatim intent)
- "Why is the app browser hard to navigate through? You just click it and it gives you a drop down with all the different selections." → The section switcher must not be a drop-down of everything.
- "There's no real appearance stuff." → Real appearance settings.
- "Use the KeepOak current design language but follow Hermes desktop; like a mix of Hermes desktop and the ChatGPT app with KeepOak's design language. Check the KeepOak redesign file, because right now the app doesn't look like keepoak.com at all."

## The design sources (read all three before drawing anything)
1. The approved KeepOak redesign, which is the design language to match: C:/Users/bishi/Projects/keepoak-redesign-public/public/ — read public-theme.css, app/portal.css, app/appearance.css, app/account-menu.css, and open a few pages under public/app/ and site/ to see the shell (Nous Portal × PostHog feel: calm paper/forest surfaces, copper accent, generous spacing, quiet borders, one clear primary action per screen). Take its tokens as the source of truth (light and dark: --paper, --card, --ink, --muted, --line, --leaf, --accent and friends). Copy the values, not the files.
2. The app's current design notes: docs/design.md in the repo (Archivo condensed display, Geist body, Geist Mono labels, bundled fonts, the dithered acorn). Keep the fonts and the acorn; replace the token values and the layout.
3. Layout model from the ChatGPT desktop app and the Hermes desktop app: a slim left rail (new chat, search, pinned/recent conversations grouped by day, with the app switcher at the top and the account/settings entry at the bottom), one main pane (the conversation, or the section you opened), and an optional right context pane that collapses. Sections (Skills, Memory, Documents, Automations, Teams, Usage, Settings) live behind a single "More" entry in the rail or as icons in a thin icon column, never as a drop-down list of everything. Command palette (Ctrl+K) to jump anywhere and to run recipes. Keyboard: Ctrl+N new chat, Ctrl+, settings, Esc closes panes.

## Deliverables
1. public/styles: new token layer (light "Daylight" and dark "Forest" from the redesign values), spacing and radius scale, focus rings, reduced-motion support. Every existing component restyled to the tokens; no hard-coded colours left in public/*.css or inline styles (grep and prove it in the report).
2. The shell: rail + main + context pane as above, responsive (rail becomes a bottom bar under 720 px), with the section switcher replaced. All existing screens keep working and keep their element ids where tests depend on them (run tests/*-ui.test.mjs and the desktop tests you can run without Electron; where an id must change, update the test in the same commit and say so).
3. Appearance settings screen: theme (Daylight / Forest / follow Windows), accent (copper default plus four KeepOak-compatible options from the redesign palette), text size (3 steps), density (comfortable / compact), font choice (Geist / system), reduce motion, and "show the acorn". Persist through the existing settings storage (there is already an appearance record used by the desktop tests; extend it, do not fork it) and apply instantly without reload.
4. Command palette (Ctrl+K): sections, conversations by title, recipes/templates, and the top actions (new chat, settings, check for updates).
5. Screenshots: use the Playwright already in devDependencies to capture Daylight and Forest at 1280×800 and 400×800 into C:/Users/bishi/AppData/Local/Temp/claude-session-files/wave2-shell/ and list the paths in the report.
6. Docs: docs/design.md rewritten to describe the new tokens and shell; README bullet; CHECKPOINT paragraph.

## Acceptance list (the report must map to each line)
- A1 No drop-down lists every section; sections reachable from the rail or Ctrl+K in one action.
- A2 Light and dark both match the redesign palette (cite the token values you copied).
- A3 Appearance settings exist with all seven controls, persist, and apply live.
- A4 All UI tests pass; any id change is listed.
- A5 No hard-coded colour outside the token layer (grep output in the report).
- A6 Works at 400 px wide without horizontal scroll.
- A7 Screenshots delivered for both themes and both widths.
