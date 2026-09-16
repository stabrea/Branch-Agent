# Branch Agent interface

The desktop and browser share one interface. It follows the approved KeepOak redesign
(`keepoak-redesign-public/public`): calm forest and paper surfaces, a copper action colour,
quiet borders, generous spacing, and one clear primary action per screen. The layout follows
a desktop assistant — a thin icon column, a rail of conversations, one main pane, and a
context pane that folds away.

## The shell

| Part | What it holds |
| --- | --- |
| Top bar | Product name, the two pane switches, "Search everything", Appearance |
| Icon column (`public/shell.css`, `.sidebar`) | Every section as an icon with its name. Settings sits at the foot. No drop-down. |
| Conversation rail (`.rail`) | New conversation, Find anything, and saved conversations grouped by Today / Yesterday / Earlier |
| Main pane (`main`) | The section you opened, with a sticky title bar |
| Context pane (`.context-panel`) | Assistant overview, counts, the dithered acorn |

Each pane can be folded away from the top bar, and the choice is remembered on the device.
Under 1000 px the rail slides over the page instead of taking a column; under 720 px the icon
column becomes a bottom bar that scrolls sideways, and the page itself never scrolls sideways.

Keyboard: **Ctrl+K** opens the command palette (sections, conversations, recipes, skills, and
the top actions), **Ctrl+N** starts a conversation, **Ctrl+,** opens Appearance, **Esc** closes
the palette or the rail. Arrow keys and Enter move through the palette.

## Tokens

`public/tokens.css` is the only place a colour is written down. `public/style.css`,
`public/shell.css` and every inline style read from it. Two themes, five accents, and the
scales for text, spacing and radius live there.

| Role | Forest (dark) | Daylight (light) | Copied from |
| --- | --- | --- | --- |
| Ground | `#03140B` | `#DDE7DA` | `site.css` `:root` / `:root[data-theme="light"]` `--ground` |
| Panel | `rgba(5,24,15,.94)` | `rgba(255,253,248,.96)` | `site.css` `--glass`, `app/portal.css` `--card` |
| Solid surface | `#051810` | `#FFFDF8` | `app/portal.css` `--card` |
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
