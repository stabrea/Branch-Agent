# Wave 2, task 1b: the bolder shell pass

Rules: wave1/BUILD.md. Branch: wave2/shell-2 from wave2/shell (after it has been merged into feat/assistant-runtime, base on origin/feat/assistant-runtime instead). Read REDESIGN.md first; this brief changes the target, not the rules.

## Why a second pass
The first pass kept the old three-panel page (top bar with tagline, marketing context pane "One place. Many possibilities.", card-heavy conversation view) and added an icon rail beside it. The owner asked for the ChatGPT desktop app crossed with the Hermes desktop app, in KeepOak's design language. Screenshots of the first pass are in C:/Users/bishi/AppData/Local/Temp/claude-session-files/wave2-shell/. Compare with the KeepOak prototype pages under C:/Users/bishi/Projects/keepoak-redesign-public/public/app/ (open two or three in a browser at 1280 px and screenshot them for yourself before designing).

## Target (be concrete)
1. **Remove the top bar.** The brand mark, the assistant name and the conversation title move into the rail header and the main pane header. No tagline. No "Search everything" / "Overview" / "Appearance" links at the top; they live in the rail and the palette.
2. **Rail = ChatGPT.** 260 px: brand + assistant name at top; "New conversation" as a quiet full-width row with a plus, not a giant copper block; search row; conversations grouped by day, each row a single line with hover actions (rename, pin, delete) revealed on hover; at the bottom the owner row (avatar circle with the initial, name, "Local workspace" status dot) which opens a small menu: Settings, Appearance, Lock, Check for updates, About. The icon column from pass 1 collapses into this rail as a compact "Sections" group (Activity, Usage, Memory, Skills, Specialists, Procedures, Schedules, Documents) rendered as small rows with icons under the conversations, collapsible, remembered. On narrow windows the rail becomes a slide-over.
3. **Main pane = one column of messages, like ChatGPT/Hermes.** Messages are left-aligned prose with a small role marker, no boxed cards; the owner's messages sit in a soft tinted bubble on the right. Tool activity appears as compact, collapsible rows inside the message flow ("Read 3 files", "Ran a command"), not as separate cards. The composer is a floating rounded box pinned to the bottom with the mic, attach (documents), Temporary toggle and Send inside it; Enter sends, Shift+Enter newline (already true). The empty state is a short greeting with four suggestion chips drawn from recipes/templates, not the demo "cards".
4. **Context pane = Hermes.** Right side, 320 px, collapsible, and useful: current model preset with a change button, running tasks with progress, recent receipts for this conversation, memory facts used in this conversation, and the acorn small at the bottom. Kill the marketing copy.
5. **Section screens** (Usage, Memory, Skills, ...) open in the main pane with the same header style; no page-in-page card frames. Keep their internal content, restyle their containers.
6. **Tokens and appearance** from pass 1 stay the single source of truth; add the ChatGPT-like neutral surfaces to the palette as Daylight/Forest variants of the existing tokens, not new hard-coded colours.

## Non-negotiables
- All existing tests pass; ids that tests depend on are kept or the tests are updated in the same commit with a list.
- 400 px works with no horizontal scroll.
- Screenshots at 1280×800 and 400×800 for both themes, plus one with the context pane open and one with the owner menu open, in C:/Users/bishi/AppData/Local/Temp/claude-session-files/wave2-shell-2/.
- Report against: B1 top bar gone; B2 rail matches the ChatGPT structure above; B3 message column without cards; B4 useful context pane; B5 sections open in the main pane; B6 tests; B7 screenshots.
