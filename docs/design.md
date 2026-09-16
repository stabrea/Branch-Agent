# Branch Agent interface

The desktop and browser share one interface. It follows the approved KeepOak redesign
(`keepoak-redesign-public/public`): calm forest and paper surfaces, a copper action colour,
quiet borders, generous spacing, and one clear primary action per screen. The layout follows the
ChatGPT desktop application crossed with the Hermes desktop application: one rail, one column of
messages, one context pane. There is no top bar, and no panel is drawn as a card floating on a
page — the three columns are flush, as the KeepOak portal is.

## The shell

| Part | What it holds |
| --- | --- |
| Rail head (`public/shell.css`, `.rail-head`) | The mark and the assistant's name with a chevron that switches project, a search icon, an appearance icon |
| Rail body (`.rail-scroll`) | "New conversation", "Find anything", then three groups that fold and are remembered for whoever this workspace belongs to: **Sections** (every screen as a row with an icon; Activity carries a small count while tasks are running), **Projects** (the workspace folders, the active one marked), **Recents** (conversations grouped by Today / Yesterday / Earlier, each row lighting up under the pointer in both themes) |
| Conversation row (`.rail-line`) | One line. Hovering reveals rename, pin and "take off this list"; those are this browser's own labels and never change the saved conversation |
| Rail foot (`.rail-foot`) | The owner row — initial, project, the connection dot — opening a menu with Settings and connections, Change the appearance, Lock session, Check for updates, About. Underneath, the quiet "Branch Agent by KeepOak" line |
| Main pane (`main`) | A title bar with the rail switch, the section name, the open conversation's name, the connection pill and the context switch; below it one 760 px column |
| Messages (`.message`) | Left-aligned prose with a small role marker. The owner's own messages sit in a soft tinted bubble on the right. Tool work is one quiet row, "Worked with 2 tools · files list, files read", that opens in place |
| Composer (`.composer-dock`) | A rounded box floating at the foot of the main pane with attach, microphone, Temporary and Send inside it, and one quiet helper line underneath. Send is a single-line pill with the arrow after the word |
| Context pane (`.context-panel`) | The model — a plain "Connect a model" button while nothing is connected, a link to change it once something is — what is running now, the receipts for this conversation in plain language, recently saved memory, three counts, and the dithered acorn, which takes the room left over and never pushes the pane taller |

The rail and the context pane each fold away from the title bar, and the choice is remembered on
the device. Under 1180 px the context pane steps aside; under 860 px the rail slides over the
page instead of taking a column. The page itself never scrolls sideways, down to 400 px.

The composer floats over the reading column rather than sitting in it. `public/shell.js` measures
the dock with a `ResizeObserver` and writes its height to `--composer-h`; `#chat` keeps exactly
that much room at its end, so nothing in the column — the welcome card, the greeting, the last
message — can come to rest underneath the composer.

Keyboard: **Ctrl+K** opens the command palette (sections, conversations, projects, recipes,
skills, and the top actions), **Ctrl+N** starts a conversation, **Ctrl+,** opens Appearance,
**Ctrl+Shift+K** folds the context pane away and back, **Esc** closes the palette, a menu, or the
rail, and from the message box it steps out of the box without touching what has been typed.
Arrow keys and Enter move through the palette. Tab walks the rail first, then the title bar, then
the messages, then the composer; the message column is a stop of its own so it can be scrolled
from the keyboard.

On a new workspace the welcome card is the greeting: "Choose how your assistant thinks", three
equal tiles for the three ways in, and one primary action. The selected tile is marked with the
accent ring, not a heavy border. Once that is done the card gives way to a short greeting and
four suggestion chips. The chips use the owner's own recipes when there are any, and fall back to
stock prompts otherwise.

## Tokens

`public/tokens.css` is the only place a colour is written down. `public/style.css`,
`public/shell.css` and every inline style read from it. Two themes, five accents, and the
scales for text, spacing and radius live there.

| Role | Forest (dark) | Daylight (light) | Copied from |
| --- | --- | --- | --- |
| Ground | `#03140B` | `#DDE7DA` | `site.css` `:root` / `:root[data-theme="light"]` `--ground` |
| Panel | `rgba(5,24,15,.94)` | `rgba(255,253,248,.96)` | `site.css` `--glass`, `app/portal.css` `--card` |
| Solid surface | `#051810` | `#FFFDF8` | `app/portal.css` `--card` |
| Rail ground | `#041710` | `#EEECE1` | variant of `--ground` / `--paper`, matching the portal rail |
| Reading ground | `#071D14` | `#FFFDF8` | variant of `--surface` |
| Owner's message | `rgba(237,241,234,.08)` | `rgba(23,40,30,.07)` | variant of `site.css` `--hover` |
| Tool step / context row | `rgba(237,241,234,.05)` | `rgba(23,40,30,.04)` | variant of `site.css` `--hover` |
| Text | `#EDF1EA` | `#17231D` | `site.css` `--text`, `app/portal.css` `--ink` |
| Muted text | `rgba(237,241,234,.78)` | `#59675F` | `site.css` `--text-2`, `app/portal.css` `--muted` |
| Line | `rgba(236,241,233,.12)` | `rgba(23,40,30,.14)` | `site.css` `--line` |
| Warm paper | `#F4F1E8` / `#FFFDF7` | `#F4F1E9` / `#FFFDF8` | `site.css` `--paper`, `app/portal.css` `--paper`/`--card` |
| Good / warn / bad | `#86D6A0` `#F2C572` `#F28B7A` | `#1F7A45` `#8A5A00` `#B3321F` | `site.css` `--ok`/`--warn`/`--bad` |

Accents (dark value, light value):

| Accent | Dark | Light | Copied from |
| --- | --- | --- | --- |
| Copper (default) | `#E07033` | `#E07033` | `site.css` `--copper` |
| Leaf | `#D3E3B6` | `#35563B` | `public-theme.css` `--pk-accent` |
| Earth | `#E4BA94` | `#77523B` | `app/appearance.css` `html[data-palette=earth]` |
| Slate | `#B0D0E0` | `#3F6378` | `app/appearance.css` `html[data-palette=slate]` |
| Ink | `#F1EDDD` | `#233529` | `public-theme.css` `--pk-ink` |

Every accent tint is derived once with `color-mix` (`--accent-soft`, `--accent-tint`,
`--accent-edge`, `--accent-ring`, `--accent-glow`), so no component invents an alpha of its own.
Spacing is `--s1`…`--s7` and radius `--r1`…`--r4`; both scale with `--density`. Focus rings are
`--ring`. Fonts stay Archivo (condensed display), Geist (body) and Geist Mono (labels), bundled
locally; the appearance screen can swap the body and display faces for this computer's own.

## Appearance

Settings → Appearance carries seven controls: theme (Forest, Daylight, or follow this
computer), highlight colour, text size, spacing, lettering, "keep things still", and "show the
acorn". Every change shows at once by writing `data-theme`, `data-accent`, `data-text-size`,
`data-density`, `data-font`, `data-motion` and `data-acorn` onto `<html>`; Save keeps the record
through `POST /api/preferences` (`PreferencesSchema` in `src/preferences.ts`). Reduced motion is
also honoured from the operating system unless the owner asks for full motion.

Appearance also carries the language. English is the source of truth; every other language file
answers the same keys and falls back to English where it does not. The choice is this browser's,
not the workspace's, and dates and numbers follow it through `Intl`.

## Rendered prose, code and the wave 6 panels

`public/web-ui.css` holds the newer pieces and uses nothing but the tokens above: rendered
markdown and code blocks, the "Look inside" sheet, the live row, the context meter, the developer
playground's fields and the offline banner. Rendered prose sets its own rhythm (paragraph line
height 1.55, headings at 1.35/1.18/1.04 rem) and borrows `--well` for code grounds, `--line` for
every rule, `--copper-text` for links and `--font-mono` for code. The "Look inside" sheet is a
680 px panel over `--scrim`, full width below 720 px. The meter is deliberately quiet: a 4 px track
in `--line` filled with `--copper`, small `--faint` text, and below 520 px the cost drops out so
the bar still fits a phone. Nothing here introduces a colour of its own.

## Help with code (wave 7)

The coder's tools add almost nothing to the interface on purpose. Settings → Developer gains one
more `<details>` block, "Help with code", holding two checkboxes and two plain text areas — one
line per program: a short name, the full address of the program, and for a language server the
kinds of file it handles. No new colour, no new component and no new layout: it borrows the same
`.check-row`, label and `textarea` rules the rest of that card already uses, and reads and writes
through `/api/developer/*` in `public/code-ide.js`.

That restraint is the design decision, not an omission. A language server or a debugger is a
program the owner already chose to install; the screen's job is to say which one, in one line, and
to make clear that nothing is downloaded and nothing runs until the switch is on. Everything else
these tools do is shown where the owner already looks: a rename appears as an ordinary multi-file
change in the approval sheet, and a checkpoint appears in Settings → Workspace snapshots with the
same "put the workspace back to this" row every other kept point has.

## Artwork

The KeepOak logo and the revolving acorn stay. Logo PNGs are bundled locally.
`public/acorn.js` adapts its analytic ellipsoid geometry, ordered dithering, colours and
rotation to this interface, and supports dragging, arrow keys, pause/resume and reduced-motion
preferences; animation suspends when hidden. "Show the acorn" hides it entirely. No KeepOak
scripts, analytics or network calls run inside the application. The native window, tray and
Windows executable use the logo.

Electron supplies the native window and tray. The renderer has no Node integration, uses
context isolation and sandboxing, and loads only the local application. Credentials are added
to authorized local requests in the main process, not embedded in URLs or page source.
