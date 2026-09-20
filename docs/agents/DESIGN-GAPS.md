# Design gaps: the approved sample vs the real app

Every place the real Branch Agent window differs from the owner's approved design sample.

**The standard, in the owner's words (2026-09-19):** *"the sample is the perfect ideal that the app is
meant to follow, so I wanted to see everything in the artifact in the real app, even the settings and
other little details aren't aligned."* The sample is right; the app follows it. Where an earlier builder
wrote down "we did it differently and here is why", that is a **gap**, not a decision — their reason is
kept here as an **owner note**, for the owner to accept or overrule. No gap argues the sample out of its
own design.

- **The ideal**: `branch-grown-up/index.html` (the built sample, sha of the copy walked here: the 2026-09-19 05:01 build), its `parts/*.js` sources and `OWNER-CRITIQUES.md`.
- **The app**: this worktree, branch `mac7/design-diff`, cut from trunk after redesign phase 1 and all of phase 2.
- **Paired screenshots**: `C:/Users/bishi/AppData/Local/Temp/claude-session-files/branch/design-gaps/<id>-sample.png` and `<id>-app.png` — 156 pairs, 312 files. Both halves of a pair are the same size and the same theme: **1440×950 light** unless the row's "Where" line names another. Where the app has no such screen at all, its half shows the screen the thing would be on. *That folder is auto-purged when this machine is restarted — copy anything worth keeping before a reboot.*

## How this was walked

Both sides were opened headless with Playwright and walked screen by screen, at **1440×950, 1024×700 and
390×844**, in **light and dark**. The sample was served from a local static server on 127.0.0.1; the app
was booted the way `tests/delight-ui.test.mjs` boots it (`createBranch` + `startServer`, port 0, host
127.0.0.1) in a throwaway data folder. Nothing that opens a window on this machine was run.

**The fairness rule used throughout.** The app ships nearly everything **off**; the sample is drawn with
its features **on** and with sample data in it. So before comparing, the app was put in the state the
sample is showing: Show everything, the microphone and Talk buttons, the acorn, the pet, achievements,
your own background, Trunks on with two Trunks made. A row is only "missing entirely" when the thing is
absent with its switch **on**. Where the only difference is that a fresh install hides something until
it is switched on, the row says so and is **not** counted as missing. Differences that come only from
the sample having conversations in it (and the fresh app having none) are left out altogether.

## What was counted

**156 gaps.** By screen:

| Screen | Gaps | Ids |
|---|---|---|
| **Settings** — the shell around every page | 14 | DG-001 – DG-014 |
| **Settings** — the controls themselves | 12 | DG-015 – DG-026 |
| **Settings** — page by page | 57 | DG-027 – DG-083 |
| **Conversation screen and composer** | 18 | DG-084 – DG-101 |
| **Trunks rail, strip and studio** | 12 | DG-102 – DG-113 |
| Side panel and its tabs | 8 | DG-114 – DG-121 |
| People and Overview | 8 | DG-122 – DG-129 |
| Acorn corner, pets, achievements, backgrounds | 9 | DG-130 – DG-138 |
| Places (Inbox, Automations, Library, Customize) | 6 | DG-139 – DG-144 |
| Usage ring and popover | 5 | DG-145 – DG-149 |
| Mode picker | 4 | DG-150 – DG-153 |
| Terminal and phone frames | 3 | DG-154 – DG-156 |

Settings alone is **83 of the 156**.

The three worst screens: **Settings** (every page; the controls themselves are the wrong kind), the
**conversation screen and its composer**, and the **Trunks rail**.

---

# 1. Settings — the shell around every page

### DG-001 · No way back that says so
- **Sample**: the Settings nav starts with `‹ Back to Branch` and an `Esc` key chip, top-left.
- **App**: only an `✕` in the top-right corner of the pane.
- **Where**: every Settings page, every size, both themes.
- **Kind**: missing entirely · **Size**: a component
- **Shots**: `DG-001-sample.png` / `DG-001-app.png`

### DG-002 · The Settings title is not the sample's
- **Sample**: the Branch mark and **Settings** set large (24 px, the display face) under the back link.
- **App**: a 11 px grey label "Settings" with no mark.
- **Where**: every Settings page. **Kind**: layout · **Size**: one line of CSS plus the mark

### DG-003 · No version line at the foot of the nav
- **Sample**: `Branch Agent 0.18.1 · sample` pinned at the bottom of the nav column.
- **App**: nothing there.
- **Kind**: missing entirely · **Size**: one component

### DG-004 · Seven Settings pages the app does not have
- **Sample**: 19 pages — General, Assistant, **Instructions & personality**, Appearance, Notifications,
  Models, Voice, Permissions, Computer & browser, Secrets, Data & usage, Advanced, Updates & about,
  **Trunks & people**, **Chat apps & devices**, **Connections**, **Skills & plugins**,
  **Memory & library**, **Automations & inbox**.
- **App**: 13 — the seven in bold are not there; the app adds **Accounts**.
- **Kind**: missing entirely · **Size**: a feature (seven pages)
- **Owner note** (STATUS-p2-settings.md): *"Places' settings (Customize, Library, Automations, Inbox) stay in their places; Settings reaches them through 'Elsewhere in Branch' and search (Go there), rather than duplicating them."* That covers four of the seven; Instructions & personality, Trunks & people and Connections are not covered.

### DG-005 · The nav's last group is links out, not pages
- **Sample**: a group headed **Places** holding six real Settings pages.
- **App**: a group headed **Elsewhere in Branch** holding four links that close Settings and go to a place.
- **Kind**: interaction · **Size**: a feature

### DG-006 · "On this page" jump links are missing everywhere
- **Sample**: under every page's intro, a row of links to each section on that page ("KeepOak account ·
  People on this computer · A PIN for switching back to you · …"), wrapping to two lines when needed.
- **App**: no such row on any of the 13 pages.
- **Where**: all sizes; at 390 px the sample still shows them.
- **Kind**: missing entirely · **Size**: a component (one renderer, used by every page)

### DG-007 · No hover explanations anywhere (#29)
- **Sample**: **356** ⓘ buttons across 18 screens; each opens a one-line explanation in the theme's own glass.
- **App**: **zero**. (74 native `title=` attributes exist, which give the operating system's plain yellow tooltip after a delay, not the sample's control.)
- **Kind**: missing entirely · **Size**: a component plus one entry per control
- **Owner critique**: #29, still open.

### DG-008 · Heading levels are upside down
- **Sample**: page title `h2`, each section `h3`.
- **App**: page title `h2`, the bucket header `h3`, then each card inside it `h2` again, and sub-parts `h3`. On General the order down the page is h2, h3, h2, h3, h3, h2, h3, h2, h2, h2 …
- **Kind**: layout · **Size**: a component

### DG-009 · Cards are boxes in two columns, not full-width sections
- **Sample**: one column the full width of the page, sections divided by a hairline, no box around anything.
- **App**: rounded filled boxes, two side by side on a wide window.
- **Where**: 1440 and 1024. **Kind**: layout · **Size**: a component
- **Owner note** (STATUS-p2-settings.md): *"Two columns on wide screens instead of one full-width column, since real cards put controls under their labels."*

### DG-010 · Every card carries a "scope" chip the sample does not have
- **App**: "Applies to everything" / "Applies to this computer only" / "Applies to this project only" pill at the top of each card.
- **Sample**: no such chip; scope is said in the section's own sentence when it matters.
- **Kind**: extra in app · **Size**: one line of CSS to hide, a copy pass to fold into the prose

### DG-011 · A bucket header band with an icon tile sits above the cards
- **App**: an icon in a rounded tile, a bold title and a grey line ("How Branch starts and keeps running / Whether it starts with your computer and keeps going when the window is closed"), plus a "N more with Advanced" pill on the right.
- **Sample**: has "N more with Advanced" too, but as a plain link at the end of the section, with no icon tile and no second title band.
- **Kind**: layout · **Size**: a component

### DG-012 · The level card has no box
- **Sample**: "How much to show" sits in a bordered card at the foot of the nav.
- **App**: the same three buttons and help line, unboxed, above a hairline.
- **Kind**: spacing · **Size**: one line of CSS

### DG-013 · At 390 px the pages are a dropdown, not a tab strip
- **Sample**: a horizontally scrolling strip of page names (General · Assistant · Instructions & personality · …) under the search box, and "Back to Branch / Esc" still at the top.
- **App**: a native `<select>` of page names, then the level control, then the page.
- **Where**: 390×844. **Kind**: interaction · **Size**: a component

### DG-014 · The achievement toast is in the wrong place and the wrong shape
- **Sample**: a bordered card in the **top-right**, medal icon, `BRONZE ACHIEVEMENT` in small caps over the name in bold.
- **App**: a grey pill in the **top-centre**, overlapping the window's own top bar, "Bronze achievement" in sentence case.
- **Kind**: layout · **Size**: one component
- **Owner critique**: #50 asked for a small toast in the top bar; the sample settled it in the top-right.

---

# 2. Settings — the controls themselves (this is the systematic one)

Counted over the 13 Settings pages both sides have, at 1440×950 light:

| Control | Sample | App |
|---|---|---|
| Toggle switch | 39 | **0** |
| Segmented choice | 446 | 112 |
| Native `<select>` dropdown | **0** | **294** |
| Tick box (`input[type=checkbox]` with no switch styling) | **0** | **102** |

### DG-015 · Every switch in the app is a tick box
- **Sample**: a real toggle switch, right-aligned on the row, with the label on the left and the help line under it.
- **App**: a square tick box to the **left** of the label, with the help line under, in the body face.
- **Where**: every Settings page, every size, both themes. 102 of them.
- **Kind**: icon / interaction · **Size**: a component (one switch renderer) plus a sweep
- **Owner critique**: this is what "#48 slop" and "a chip that is a tick box" mean.

### DG-016 · Every three-way switch in the app is a dropdown
- **Sample**: three buttons in one glass segment — `Off | When needed | On`.
- **App**: a native `<select>`.
- **Kind**: interaction · **Size**: a component plus a sweep

### DG-017 · The three-way switch has four different orders and wordings in the app
- **Sample**: always `Off · When needed · On`, in that order, everywhere.
- **App**, seen on one walk: `Off / On / Only when it is needed`, `Off / On / When needed`,
  `Off / Only when it is needed / On`, `Off / When needed / On`, and
  `Off / When needed: warnings and errors only / On: everything`.
- **Kind**: ordering + copy · **Size**: a copy pass (cheap, and very visible)

### DG-018 · Every choice list in the app is the browser's own dropdown
- **Sample**: one glass dropdown for every choice, each option carrying a one-line description, the
  highlight in the theme's own tint, opening and closing by the same rule as every other menu.
- **App**: the operating system's `<select>` with its own arrow and its own blue highlight.
- **Kind**: colour / interaction · **Size**: a component
- **Owner critique**: #29 ("dropdowns use the system's blue highlight instead of liquid glass"). The app
  does have `glass-select.js`; it is not reaching these 294 controls.

### DG-019 · Field labels are set in a technical face
- **Sample**: labels in the body face, sentence case, the same size as the words around them.
- **App**: small letter-spaced monospace for field labels — "Project", "Value", "What you will call it",
  "Several accounts per connection", "Requests for new packages and tool servers", "How it fits".
- **Kind**: copy / layout · **Size**: one line of CSS
- **Owner critique**: #60 ("raw internal labels").

### DG-020 · Radio choices are not the sample's choice cards
- **Sample**: a full-width card per choice — a radio, a bold title and a sentence — and the chosen one
  wearing a tinted border (Permissions, Updates, and the first-run questions).
- **App**: a dropdown, with the chosen option's sentence repeated underneath in a separate "What that
  means" block.
- **Kind**: layout / interaction · **Size**: a component
- **Owner critique**: #28 ("choice cards"), #20.

### DG-021 · Sliders are the browser's blue, not the theme's colour
- **App**: "How much the theme's colour covers it" (Appearance › Your own background) and the other
  ranges draw with the operating system's blue accent.
- **Sample**: every slider wears the theme's own accent.
- **Kind**: colour · **Size**: one line of CSS (`accent-color`)

### DG-022 · The file picker is the browser's own grey button
- **App**: Appearance › Your own background shows a raw `Choose File / No file chosen` control.
- **Sample**: a themed button in the sample's own language.
- **Kind**: icon / layout · **Size**: a component

### DG-023 · Jargon left in words a person reads
- **App**: "BRANCH_MODEL_PRESETS in the launch environment", "Tool names separated by commas; a star
  matches the rest, as in browser.*", "Rest a failed model for (seconds)", "Stay signed in for (hours)",
  "Client id", "Issuer address", "Client secret's name in the locker (if the service needs one)",
  "Trace files for a tracing viewer", "Task counters for your own collector", "Danger zone",
  "Under the hood", "The number of the thing to label", "e.g. client-site".
- **Sample**: plain words throughout; no bracketed units, no environment-variable names, no "Danger zone".
- **Kind**: copy · **Size**: a copy pass (cheap)

### DG-024 · An option's description is rendered as a heading
- **App**, Computer & browser: four headings read
  "Runs on this computer, held to its memory and processor limits by Windows",
  "Not on this computer: runs inside a container, which cannot see anything on this computer except the folder it is given",
  "Runs inside the Linux you already have on this computer, with a copy of the folder it is given",
  "Not on this computer: runs in Windows' own throwaway desktop, which is thrown away when it closes".
- **Sample**: those are the descriptions on four choice cards under one heading, "Where scripts run".
- **Kind**: layout · **Size**: a component

### DG-025 · A "Save" button under controls the sample saves as you go
- **App**: "Save model settings", "Save project", "Save this setting", "Save", "Save secret", "Save this group".
- **Sample**: a choice takes effect at once; only the things that really are a form (identity text, project
  instructions) carry a Save.
- **Kind**: interaction · **Size**: a feature (per card)

### DG-026 · "Put back as shipped" and "Start from a preset" have no home in the sample
- **App**: General ends with "All your settings at once" → "Start from a preset" (a long dropdown:
  Private and local / Cheapest / Most capable / Hands-off / Careful) and "Put settings back".
- **Sample**: no such section on General.
- **Kind**: extra in app · **Size**: a component

---

# 3. Settings — page by page

### DG-027 · General: the KeepOak account card is missing (#14)
- **Sample**: the first card on General — the KeepOak mark, "Connected · you@example.com", "Operator plan ·
  6 vCPU, 12 GB memory · your computer is Online", a green "Connected" chip, three ✓ lines about what is
  and is not shared, and **Open your KeepOak computer · KeepOak usage & billing · Disconnect**.
- **App**: nothing; Branch has no KeepOak account link.
- **Kind**: missing entirely · **Size**: a feature
- **Owner note** (STATUS-p2-shell.md): *"The sample's 'Your KeepOak computer' tab is left out (no such link)."* (STATUS-p2-delight.md the same, for the achievement.)

### DG-028 · General: "People on this computer" is a raw form, not a card
- **Sample**: a card listing each person with their face, name, role and "Here now", a "Switch to …"
  button each, then **Open People** and **+ Invite someone**.
- **App**: two bare text fields ("Their name", "Their PIN, four to eight digits") and an "Add them" button.
- **Kind**: layout · **Size**: a component

### DG-029 · General: the PIN card is not the sample's
- **Sample**: "A PIN for switching back to you" with a password field showing **Not set** and a
  "Keep it running" button, and a cross-link "Set in A PIN for switching back to you ›".
- **App**: a lone `Your PIN, four to eight digits` field inside the People section.
- **Kind**: layout / ordering · **Size**: a component

### DG-030 · General: cross-links between sections are missing
- **Sample**: "Set in A PIN for switching back to you ›", "Set in People on this computer ›" where a
  setting really lives elsewhere.
- **App**: none.
- **Kind**: missing entirely · **Size**: a component

### DG-031 · General: section order differs
- **Sample**: KeepOak account · People on this computer · A PIN for switching back to you · How Branch
  starts and keeps running · Your projects · Keys and typed commands · Signing in from other devices.
- **App**: How Branch starts and keeps running · Your projects · People and sharing · Keys and typed
  commands · All your settings at once.
- **Kind**: ordering · **Size**: a component

### DG-032 · Assistant: the section names are doubled
- **App**: the bucket header reads "Who your assistant is" and the first card inside it reads
  "Who your assistant is" again, then "Assistant identity".
- **Sample**: one heading, "Who your assistant is".
- **Kind**: copy · **Size**: a copy pass

### DG-033 · Appearance: no "Day or night" control on the page
- **Sample**: a segmented `Follow this computer | Moonlight | Daylight` at the top of Theme, with the line
  "Every theme has both. Switching keeps the theme you chose."
- **App**: nothing on Appearance; the light/dark choice is the window's own small contrast button in the rail.
- **Kind**: missing entirely · **Size**: a component
- **Owner critique**: #39 wants the "Clear the view" eye placed right of Moonlight in that row.

### DG-034 · Appearance: no "Clear the view" eye beside the light/dark row (#39)
- **Sample**: the eye sits immediately right of Moonlight/Daylight.
- **App**: the eye is a separate icon in the window's top bar.
- **Kind**: ordering · **Size**: a component

### DG-035 · Appearance: no "Search 45 themes" box
- **Sample**: a search box above the gallery.
- **App**: none; just a count, "44 · Slate", right-aligned on the Theme heading.
- **Kind**: missing entirely · **Size**: a component

### DG-036 · Appearance: no theme filter chips
- **Sample**: `All · Branch · KeepOak · Editors & terminals · Easy in daylight · High contrast`.
- **App**: none; instead a word under some tile names.
- **Kind**: missing entirely · **Size**: a component
- **Owner note** (STATUS-p2-settings.md): *"No theme filter chip bar (#48); plain-word tags instead."*

### DG-037 · Appearance: the theme tiles are a quarter of the sample's size and show nothing
- **Sample**: a ~270 px tile drawing a little Branch window — rail, pane, accent — with the theme's name
  **below the tile**, and a chip on the right of the name for **Default** and **High contrast**.
- **App**: a ~135 px tile with three grey bars and a dot, name **inside** the tile, and the words
  "Easiest to read" / "Softer" as plain text under the name.
- **Kind**: layout · **Size**: a component

### DG-038 · Appearance: one theme and one group are missing
- **Sample**: 45 themes, first group **Branch** (a theme called Branch), then KeepOak, then the rest.
- **App**: 44 themes, first group KeepOak; no Branch group and no Branch theme.
- **Kind**: missing entirely · **Size**: one theme record

### DG-039 · Appearance: the mirrors are small and side by side, not the sample's stacked pair
- **Sample**: two large mirrors stacked on the right, each a detailed copy of the real window, labelled
  with a chip in its own bottom-right corner ("Moonlight", "Daylight").
- **App**: two small mirrors side by side under a heading "Your window in this theme, dark and light",
  labelled underneath ("Slate · Dark", "Slate · Light").
- **Kind**: layout · **Size**: a component
- **Owner note** (STATUS-p2-settings.md): *"Mirrors are side by side (#38), not stacked."*

### DG-040 · Appearance: the section order differs
- **Sample**: Theme · A pet · Theme and lettering · What a conversation shows.
- **App**: Theme and lettering (as the bucket) › Theme, then Just for fun (pet, achievements, background), then What's on screen.
- **Kind**: ordering · **Size**: a component

### DG-041 · Models: the tabs are pills, not the sample's underlined tabs
- **Sample**: five text tabs on a hairline, the chosen one underlined in the accent.
- **App**: five pill buttons, the chosen one a filled dark pill.
- **Kind**: layout · **Size**: one line of CSS

### DG-042 · Models: "Check your connections" is missing from the Connection tab
- **Sample**: a section "Check your connections" — "Asks each connection what it can do right now: whether
  the key still works, how many models it lists, and whether it can handle speech, pictures and comparing
  passages." — with a **Check every connection** button.
- **App**: not on this tab.
- **Kind**: missing entirely · **Size**: a feature

### DG-043 · Models: "Choose a provider" and "Default model" are stacked, not on a row
- **Sample**: the label on the left with an ⓘ, the control right-aligned on the same row, the help line under.
- **App**: label above, control below, full width.
- **Kind**: layout · **Size**: one line of CSS

### DG-044 · Models: the fallback list is a tick-box list
- **Sample**: a named, ordered list with each row's own state.
- **App**: one tick box beside "Default connection · configured", with "If the default model fails, the ticked ones are tried in order." under it.
- **Kind**: interaction · **Size**: a component

### DG-045 · Accounts: the whole list is missing
- **Sample**: "Search accounts", three filters (**Every provider · Every kind · Everyone's**), a
  **＋ Add an account** button, a select-all row ("230 of 230 · Select rows to check them again, switch
  them off or sign them out together"), then rows with a provider dot, the account's name, "(new work
  uses this one)", a sub-line ("ChatGPT · Plan sign-in · You"), a state chip (**Ready** / **Reached its
  plan limit, until about 6 pm** / **Resting after a refusal, until about 4:10 pm**) and a **usage ring
  with a number**.
- **App**: none of it, not even an "Add an account" button. The page holds one dropdown.
- **Kind**: missing entirely · **Size**: a feature
- **Owner note** (STATUS-p2-accounts.md): *"No single cross-provider account fallback list: Branch has none. The page shows the two real mechanisms instead."* and *"Accounts rows are a plain list, not the sample's virtual list of 200+ (the server caps a list at 50); a search appears past six."*

### DG-046 · Accounts: "Share work between these accounts" became a dropdown with a different name
- **Sample**: "Share work between these accounts", segmented `Off | When needed | On`, with the abuse warning under it.
- **App**: "Several accounts per connection", a `<select>`, and the warning in a left-barred quote block above.
- **Kind**: copy / interaction · **Size**: a component

### DG-047 · Voice: "Listening right now" is missing
- **Sample**: Listening right now · Talking and listening · The voices it speaks with.
- **App**: Talking and listening · Speak and see the words · A word that starts a turn · Talking with a key · The voices it speaks with · Your computer's own voice · Briefings and answers by voice · Other speech services. No "Listening right now".
- **Kind**: missing entirely · **Size**: a component

### DG-048 · Permissions: "When to check with me" is a dropdown, not four choice cards
- **Sample**: four cards — **No approvals**, **Ask before changes**, **Just do it inside my workspace**,
  **Read only** — each with its own sentence, the chosen one tinted.
- **App**: a `<select>` headed "How should Branch behave?", then a separate "What that means" block.
- **Kind**: layout / interaction · **Size**: a component
- **Owner critique**: #20, #28.

### DG-049 · Permissions: Lockdown is not on the page
- **Sample**: a section of its own — heading, "The one switch that refuses commands and makes everything
  else wait for your yes.", a row "Lockdown" with its paragraph and a switch on the right.
- **App**: not on the page at Regular; Lockdown lives in the More menu. The page's stop control is called
  "Emergency stop", with two tick boxes ("Every tool", "Everything that reaches past this computer"), two
  comma-list fields (Sites, Tools), **Press the stop**, an **Authenticator code** field and **Let it go**.
- **Kind**: missing entirely / copy · **Size**: a component
- **Owner note** (STATUS-p2-settings.md): *"S15 (1440 and 390, nothing peeked): Lockdown in the More menu…"*

### DG-050 · Permissions: the section names differ
- **Sample**: When to check with me · Lockdown · Settings you have pinned · Limits on one task and one
  person · When Branch checks with you · Keeping things safe.
- **App**: When Branch checks with you (bucket) › When to check with me · How fast one conversation may
  work · Emergency stop · A second look before approvals.
- **Kind**: copy / ordering · **Size**: a copy pass

### DG-051 · Computer & browser: "Paired devices" is missing
- **Sample**: the page opens with **Paired devices**, then Your screen keyboard and apps, Running commands
  safely, The browser, Your other computers.
- **App**: no Paired devices section; the page opens on "Your screen, keyboard and apps".
- **Kind**: missing entirely · **Size**: a component

### DG-052 · Secrets: the saved-secret list has no logos and no plain names (#60)
- **Sample**: a list of rows, each with the service's real mark (Telegram, OpenAI, GitHub, a key tile for
  an unknown one), the plain name in bold ("Telegram bot token") and "Default project · locked away" under it.
- **App**: no list at the top of the page at all; the card opens on the **form** — Project, "The name your
  commands use for it (capital letters, like DEPLOY_TOKEN)" with a `DEPLOY_TOKEN` placeholder, Value, Save
  secret — and an empty-state box under it.
- **Kind**: missing entirely / ordering · **Size**: a component
- **Owner note** (STATUS-p2-accounts.md): *"Secrets keep the name commands use visible under the plain name at every level (it is what commands need); the level control can hide `.secret-raw` later."*

### DG-053 · Secrets: "Where Branch reads saved sign-ins from" is missing
- **Sample**: five cards in a row with the real marks — **Apple Keychain** (Available · On this Mac ·
  Change), **Windows Credential Manager** (Windows only · Set up), **Bitwarden** (Connected · Signed in on
  this Mac · Change), **1Password** (Not set up · Set up), **KeePassXC** (Not set up · Set up) — and the
  line "Branch never shows you or the assistant a password. It fills one item at a time, only the ones you list."
- **App**: nothing.
- **Kind**: missing entirely · **Size**: a feature
- **Owner note** (STATUS-p2-accounts.md): *"Password managers have no list in the app to decorate."*
- **Owner critique**: #62 named the password-manager status chips by name, so they are expected to exist.

### DG-054 · Secrets: "Filling a saved sign-in" is a dropdown, not the row control
- **Sample**: the label on the left with an ⓘ, `Off | When needed | On` right-aligned on the same row.
- **App**: a label above a `<select>`, then a nine-line paragraph.
- **Kind**: interaction · **Size**: one control

### DG-055 · Data & usage: "Saving progress before an allowance runs out" is not a section here
- **Sample**: Usage · What each connection has left · **Saving progress before an allowance runs out** ·
  What is kept and for how long · What it costs.
- **App**: What it costs first; no section by that name.
- **Kind**: ordering / missing · **Size**: a component
- **Note**: the 95 % prompt itself exists (phase 1, `src/usage-glance.ts`); it is its home and heading on this page that differ.

### DG-056 · Data & usage, Computer & browser, Advanced: an "Under the hood" group the sample has not got
- **App**: "Under the hood" groups appear on three pages (Proxy and trusted certificates; Counting how
  Branch is used; Task counters for your own collector).
- **Sample**: no such group; those controls sit in the named section they belong to, at Technical.
- **Kind**: extra in app · **Size**: a component

### DG-057 · Updates & about: "The keeper" is missing, "Danger zone" is extra
- **Sample**: Updates · Updating by itself · **The keeper**.
- **App**: Updates · Updating by itself · Help and problems · Report a problem · Starting over · **Danger zone**.
- **Kind**: missing entirely / copy · **Size**: a component

### DG-058 · Instructions & personality has no page (#40)
- **Sample**: its own page, "Its files", where SOUL.md, IDENTITY.md, USER.md, AGENTS.md, TOOLS.md, SOP.md,
  MEMORY.md and the rest are read and edited with a live preview and a revert.
- **App**: the editor exists but lives as a card inside Assistant ("Your assistant's files").
- **Kind**: ordering · **Size**: a component
- **Owner note** (STATUS-p2-accounts.md): *"Agent files: Branch already had an owner-only editor (R17-S05); the new card reuses it and adds undo, preview, counter and starters, rather than a second editor. No 'Write it for me', no per-Trunk files, no multi-version history (only the last save)."*

### DG-059 · Trunks & people, Chat apps & devices, Connections have no Settings page
- **Sample**: three pages with real sections — Trunks · Edit Trunk · A person's card; Talk to Branch from
  your phone and chat apps · Email and other pages · While it works in a chat; Other AI tools · Your own accounts.
- **App**: the settings exist inside Customize and elsewhere; there is no Settings page for them.
- **Kind**: missing entirely · **Size**: a feature

### DG-060 · Skills & plugins, Memory & library, Automations & inbox have no Settings page
- **Sample**: three pages, 17 sections between them.
- **App**: reached only through "Elsewhere in Branch", which leaves Settings.
- **Kind**: missing entirely · **Size**: a feature
- **Owner note**: as DG-004.

### DG-061 · The search results head reads differently
- **Sample**: searching puts a heading in the column naming what was found.
- **App**: the same search shows rows, several of which used to read only "Switch" or a placeholder; those
  were fixed in phase 2, but a setting whose control is not drawn yet is still named in English in French.
- **Kind**: copy · **Size**: a copy pass
- **Owner note** (STATUS-p2-settings.md): *"In French, a setting whose control is not drawn yet (behind a switch, in a place not visited) is named in English."*

### DG-062 · 96 declared settings have no search entry
- **App**: `NOT_IN_SEARCH.notYetReviewed` holds 96 settings nobody has looked at one by one, plus 47
  launch-configuration keys.
- **Sample**: every one of the 530 is rendered and findable (its own audit: 530/530).
- **Kind**: missing entirely · **Size**: a feature
- **Owner note** (STATUS-p2-settings.md): *"Take names off as they are indexed or given a reason; the list may only shrink."*
- **Owner critique**: #19, "Don't skip any settings".

### DG-063 · The page intro sentence is the same but the page title is smaller
- **Sample**: the page title is set in the display face at ~34 px with the accent colour.
- **App**: ~30 px, in the text colour.
- **Kind**: colour / layout · **Size**: one line of CSS

### DG-064 · Settings has no keyboard chip for Esc
- **Sample**: an `Esc` chip beside the back link tells you the key.
- **App**: Esc works; nothing says so.
- **Kind**: missing entirely · **Size**: one line of markup

### DG-065 · Nav icons differ from the sample's
- **Sample**: General is a cog, Assistant a person, Instructions a page, Appearance a leaf-pen,
  Notifications a bell, Models a compass rose, Voice a microphone, Permissions a shield, Computer a
  monitor, Secrets a key, Data a target, Advanced a wrench-pen, Updates a sprout.
- **App**: General is three sliding lines (not a cog), Accounts is two people (the sample's key), and the
  rest are near but not the same weight.
- **Kind**: icon · **Size**: a component
- **Owner critique**: #37 wanted Settings itself to be a gear; General's own icon is now the odd one.

### DG-066 · At 1024 px the two columns stay two columns
- **Sample**: one column at every width; nothing reflows.
- **App**: two boxed columns at 1024 as well, so each card is about 350 px wide and every sentence wraps
  three or four times.
- **Where**: 1024×700. **Kind**: layout · **Size**: one line of CSS

### DG-067 · There is no way to pin a setting
- **Sample**: Permissions has a section "Settings you have pinned" — "Pin a setting and it is fixed.
  Somebody else who uses this computer still sees it, and sees that you pinned it."
- **App**: no pinning anywhere.
- **Kind**: missing entirely · **Size**: a feature

### DG-068 · The Models tabs are the app's only tabbed page
- **Sample**: Models has five tabs; so does the app. But the sample also gives **Chat apps & devices** and
  **Memory & library** their own tabbed sections; the app splits them across places.
- **Kind**: layout · **Size**: a component

### DG-069 · No "Trunks" tab inside Customize in Settings
- **Sample**: Customize › Trunks lists every Trunk in a table with an inline edit.
- **App**: Customize has Skills · Specialists · Plugins · Connections · Channels — no Trunks tab.
- **Kind**: missing entirely · **Size**: a component

### DG-070 · Notifications gains two sections the sample folds into one
- **Sample**: "When Branch gets your attention".
- **App**: that, plus "Days off and quiet hours" and "Interruptions from background work" as siblings.
- **Kind**: ordering · **Size**: a component

### DG-071 · The Settings pane is inset, the sample's is edge to edge
- **Sample**: Settings fills the window; the nav column runs from the very top to the very bottom.
- **App**: the pane is inset by a few pixels with a rounded corner and the window's own background showing
  round it.
- **Kind**: spacing · **Size**: one line of CSS

### DG-072 · Card text is left at full measure
- **Sample**: prose in a card is held to about 70 characters.
- **App**: some paragraphs run the full width of the card and others stop short, with no rule.
- **Kind**: spacing · **Size**: one line of CSS

### DG-073 · "N more with Advanced" is a pill in the header band, not a link at the end
- **Sample**: a quiet link after the last control of a section.
- **App**: a pill at the right of the bucket header, away from the controls it is about.
- **Kind**: layout · **Size**: one line of CSS

### DG-074 · The empty state inside a card is a filled box
- **App**: "No secrets saved here yet." sits in a grey filled box inside the card.
- **Sample**: an empty state is one quiet line, no box.
- **Kind**: layout · **Size**: one line of CSS

### DG-075 · The level control's own words are right; its position at 390 px is not
- **Sample**: at 390 px the level card sits above the page, under the tab strip.
- **App**: the same, but the level control is a full-width segmented bar with no card round it and no
  "How much to show" heading of the sample's weight.
- **Kind**: spacing · **Size**: one line of CSS

### DG-076 · The nav's group headings are smaller and quieter than the sample's
- **Sample**: "Models and voice", "Safety", "Care", "Places" at 12 px, letter-spaced, in the muted colour,
  with 18 px above.
- **App**: the same words at 10 px with less room above.
- **Kind**: spacing · **Size**: one line of CSS

### DG-077 · Achievement wording differs
- **Sample**: "Visited Models", "Visited Secrets", "Visited Instructions & personality" — one per page.
- **App**: "3 Settings pages", "6 Settings pages" — a count, not the page.
- **Kind**: copy · **Size**: a copy pass

### DG-078 · Settings search box has no key chip
- **Sample**: the search box carries the magnifier and is the same height as the nav rows.
- **App**: the same box is 8 px shorter and its placeholder is set in the technical face.
- **Kind**: spacing · **Size**: one line of CSS

### DG-079 · "Elsewhere in Branch" closes Settings without saying so
- **App**: clicking Inbox in the nav leaves Settings.
- **Sample**: the equivalent pages are Settings pages; nothing closes.
- **Kind**: interaction · **Size**: a component

### DG-080 · Advanced carries three sections of developer plumbing the sample keeps at Technical
- **App** at Advanced: "Trace files for a tracing viewer", "Where each client is", "Task counters for your
  own collector", "Ask two models the same thing", "Coding polish".
- **Sample**: Advanced is two sections, Fixing problems and For developers, and the plumbing is inside them.
- **Kind**: ordering · **Size**: a component

### DG-081 · Data & usage leads with cost, the sample leads with usage
- **Sample**: Usage first, then What each connection has left.
- **App**: What it costs first.
- **Kind**: ordering · **Size**: one line of code

### DG-082 · No section on Data & usage names the honest states
- **Sample**: "What each connection has left" explains **Measured · Estimate · Not published · Not asked ·
  On this computer** as words a person reads.
- **App**: the states exist in the popover but the page does not name them.
- **Kind**: missing entirely · **Size**: a copy pass

### DG-083 · The app's Settings has no "Trunks & people" way to a person's card
- **Sample**: Settings › Trunks & people › "A person's card".
- **App**: a person's card exists only on the People place.
- **Kind**: missing entirely · **Size**: a component

---

# 4. The conversation screen and the composer

### DG-084 · The message box is a tall panel, not the sample's slim bar
- **Sample**: one bar about 48 px tall — `＋` · the text field · the mode chip · the model chip with the
  provider's mark · the microphone · the round Talk-live button.
- **App**: a box about 210 px tall — a large square `＋` on its own line, the text field, then a row of
  **Default connection · picture · paperclip · microphone · Talk · a tick box "Temporary" · a tick box
  "Ask me questions first"**, then a second row of **Your assistant ▾ · New conversation · Ask first ▾ ·
  Send**.
- **Where**: every size, both themes.
- **Kind**: layout · **Size**: a component
- **Owner critique**: #12 ("chat bar too thick"), #30 ("composer chips too squished"), #2 ("looks like shit").

### DG-085 · Two tick boxes sit in the message box
- **App**: "Temporary" and "Ask me questions first" as square tick boxes inside the composer.
- **Sample**: neither is in the message box; both are choices under `＋`.
- **Kind**: interaction · **Size**: a component

### DG-086 · Send drops onto its own line at 1440 px
- **App**: with the side panel closed at 1440×950, the chips row fills the width and the **Send** button
  wraps to a third line at the far left, under "＋".
- **Sample**: the bar never wraps at any width down to 200 px (its own sweep proves it).
- **Where**: 1440×950 and 1024×700, panel closed.
- **Kind**: layout · **Size**: one line of CSS
- **Owner critique**: #57, #58, #59.

### DG-087 · The chips do not collapse to marks when the column narrows (#30)
- **Sample**: with the side panel open, the mode chip becomes a shield and a chevron and the model chip
  becomes the provider's mark and a chevron; the bar keeps its height.
- **App**: the chips keep their full words and the bar wraps instead.
- **Kind**: layout · **Size**: a component

### DG-088 · No model chip beside the message box until the panel is open
- **Sample**: "GPT-5.6 Terra" with the OpenAI mark sits in the bar at all times.
- **App**: a "Default connection" pill with a green dot; no provider mark.
- **Kind**: icon · **Size**: a component
- **Owner critique**: #21 ("use the real logos"), #30.

### DG-089 · Two dropdowns and a line float above the message box
- **App**: "How it should work: Just do it" and "Check back with me: Before every step" and
  "Use this for the whole project" float in the middle of the empty conversation, well above the composer.
- **Sample**: nothing floats there; those choices live under `＋`.
- **Kind**: extra in app · **Size**: a component

### DG-090 · The sidebar header is the app's name, not this computer
- **Sample**: a computer's face tile, **Taofik's Mac**, a "this one" chip, "TK-1 · Mac computer · Needs
  you" under it, and a pencil to change how it looks.
- **App**: the Branch mark, "Branch Agent", a search icon and a contrast icon.
- **Kind**: layout · **Size**: a component

### DG-091 · No "Conversations | Trunks" tabs in the sidebar
- **Sample**: two tabs at the top of the list.
- **App**: one list, with a "Trunks" block dropped into it.
- **Kind**: missing entirely · **Size**: a component

### DG-092 · "Overview" is not in the sidebar
- **Sample**: Overview · Inbox 3 · Automations 3 on · Library · Customize.
- **App**: Inbox · Automations · Library · Customize. Overview has **no way in from the window at all**
  (there is no `.lx-place-link[data-place="overview"]`).
- **Kind**: missing entirely · **Size**: one line of code plus the page

### DG-093 · "New conversation" has no chevron for choosing who answers
- **Sample**: "＋ New conversation ⌄" — the chevron opens "Start with a chosen Trunk".
- **App**: "New conversation" and a separate `＋`; the choice is a "Your assistant ▾" select in the composer.
- **Kind**: interaction · **Size**: a component

### DG-094 · The sidebar footer has no theme row (#39)
- **Sample**: "🖊 Theme · Slate", "Daylight", and the **eye** on one row above the owner row.
- **App**: nothing; the theme is only in Settings and a contrast icon in the header.
- **Kind**: missing entirely · **Size**: a component

### DG-095 · The owner row is truncated
- **Sample**: "TB Taofik · Owner ⌄" with the gear beside it.
- **App**: "B Default" over "● Default connection · configu…" — the second line is cut with an ellipsis in
  every size and theme (the element overflows in 93 of the scenes walked).
- **Kind**: layout · **Size**: one line of CSS

### DG-096 · No bottom strip of open conversations
- **Sample**: a strip across the bottom — `OPEN` then a tile per open conversation with its Trunk's face,
  then the connection's usage ("ChatGPT plan · 12% left · resets at 6 pm").
- **App**: nothing; the bottom line reads "New conversation · tools leave a record" and a context meter.
- **Kind**: missing entirely · **Size**: a feature

### DG-097 · No search box in the top bar
- **Sample**: a `Search  Ctrl K` box in the top bar, always visible.
- **App**: "Find anything Ctrl K" is a row inside the sidebar list.
- **Kind**: ordering · **Size**: a component

### DG-098 · The guide button is missing (#36)
- **Sample**: a lightbulb in the top bar beside the shield.
- **App**: no guide, tour or lightbulb.
- **Kind**: missing entirely · **Size**: a feature
- **Owner note** (STATUS-p2-shell.md): *"Guide lightbulb (#36): **not present in the real app** (no guide, tour or compass button exists), so nothing to change; deliberately not invented."*

### DG-099 · The top bar says "Conversation", not where you are
- **Sample**: a breadcrumb — the computer's mark, **Taofik's Mac**, a "this one" chip, `/`, the
  conversation's name, then the assistant's face and the faces of the people in it.
- **App**: a panel icon and the word "Conversation".
- **Kind**: copy / layout · **Size**: a component

### DG-100 · A "Saved conversations" disclosure sits at the top of the thread
- **App**: a collapsed `▸ Saved conversations` row above the empty state.
- **Sample**: nothing there.
- **Kind**: extra in app · **Size**: one line of code

### DG-101 · The context meter has no place in the sample
- **App**: "0 of 128,000 words of context" with a bar, bottom-left under the composer.
- **Sample**: the same corner says "About $0.02 so far", right-aligned.
- **Kind**: extra in app / ordering · **Size**: a component

---

# 5. The Trunks rail, the strip and the studio

### DG-102 · Trunks are round faces in a 56 px icon rail, not the sample's shaped rail
- **Sample**: the rail holds every computer, phone and Trunk — computers as rounded squares, phones tall,
  a Trunk in whichever shape its owner picked — each with a status ring, in the order the owner dragged them.
- **App**: two round faces with a green ring and a small count badge, above a `＋`.
- **Kind**: layout · **Size**: a component

### DG-103 · A giant unstyled "Trunks" heading appears in the sidebar
- **App**: with Trunks on, the word **Trunks** renders at about 34 px in the display face, three times the
  size of "Projects" and "Recents" beside it.
- **Sample**: the same list sits under a tab, not a heading.
- **Where**: 1440, 1024 and 390, both themes.
- **Kind**: layout · **Size**: one line of CSS

### DG-104 · The studio has three tabs, the sample has four
- **Sample**: A new Trunk · Another computer · Your phone · **Your KeepOak computer**.
- **App**: the first three.
- **Kind**: missing entirely · **Size**: a component
- **Owner note** (STATUS-p2-shell.md): *"The sample's 'Your KeepOak computer' tab is left out (no such link)."*

### DG-105 · The studio has 8 colours, the sample has 21 and a custom one
- **Sample**: two rows of swatches ending in a rainbow swatch that opens a colour picker.
- **App**: one row of eight.
- **Kind**: missing entirely · **Size**: a component

### DG-106 · "Follow my theme" is a tick box on one line
- **Sample**: a row — the label "Follow my theme", a switch on the right, and "Takes the highlight colour
  of whichever theme is on" underneath.
- **App**: a tick box with the whole sentence beside it on one line.
- **Kind**: interaction · **Size**: one control

### DG-107 · "Starts in" is missing from the studio
- **Sample**: a select, "Starts in — Taofik's Mac", under "What it does, in a few words".
- **App**: not there.
- **Kind**: missing entirely · **Size**: one control

### DG-108 · The face choices differ
- **Sample**: Letters · Emoji · Photo · Pixel pattern.
- **App**: **Drawn face** · Letters · Emoji · Photo · Pixel pattern.
- **Kind**: extra in app · **Size**: one line of code

### DG-109 · The preview panel is missing "In the conversation header"
- **Sample**: three previews — **In the rail**, **In the conversation header** ("Taofik's Mac / Gardener"),
  **On its replies** ("Gardener · GPT-5").
- **App**: two — **In the strip** and **On its replies**.
- **Kind**: missing entirely · **Size**: a component

### DG-110 · The strip preview labels each state under the face; the sample says it in one line
- **Sample**: three faces and the words "online · needs you · off" beside them.
- **App**: "Ready", "Needs you", "Off" under each face.
- **Kind**: copy / layout · **Size**: one line of CSS

### DG-111 · Trunks are a strip across the top in the app, a rail down the side in the sample
- **App**: `public/strip.js` puts Trunks in a strip; on a phone they go into a slide-over list.
- **Sample**: a rail on the left at every size, and a strip of faces across the **bottom** on a phone.
- **Kind**: layout · **Size**: a feature
- **Owner note** (STATUS-p2-everywhere.md): *"Left out on purpose: the sample's Trunks strip across the top of the phone (p2-shell owns the Trunks rail; the phone shows it in the slide-over side list)."*

### DG-112 · No right-click menu on a Trunk in the rail
- **Sample**: right-click a rail face for Change look · Rename · Settings · Pin · Move · Hide · Remove, and
  a pencil on hover.
- **App**: the menu exists on the strip; the rail faces have no pencil and no hover affordance.
- **Kind**: interaction · **Size**: a component
- **Owner critique**: #8.

### DG-113 · There is no way to add a Trunk with Trunks off
- **App**: with Trunks off (a fresh install) the strip and its `＋` are not drawn, so the studio has no way in.
- **Sample**: the `＋` is always in the rail; pressing it with Trunks off should say so and offer the switch.
- **Kind**: interaction · **Size**: a component
- **Note**: `studio.js` does answer "Trunks off → the studio says so and offers the switch" once it is
  open; the missing piece is the way in.

---

# 6. The side panel and its tabs

### DG-114 · The panel is a docked column titled by its tab, not a card titled "Side panel"
- **Sample**: a floating card headed **Side panel** with an `✕`, sitting over the conversation.
- **App**: a docked third column headed **Activity**.
- **Kind**: layout · **Size**: a component

### DG-115 · Five of the six tabs lose their words
- **Sample**: six tabs, each an icon **and** a word — Activity · Plan · Files · Memory · Browser · Terminal.
- **App**: the chosen tab is a pill with its icon and word; the other five are icons only.
- **Kind**: copy / layout · **Size**: one line of CSS
- **Owner critique**: #16 ("the side-panel switch is 4 buttons, should be one"), #53 ("still can't find the in-app browser and terminal").

### DG-116 · "Open this by itself while a task works" is missing from the panel foot
- **Sample**: a switch on that row at the bottom of the panel.
- **App**: the setting exists elsewhere; there is no control in the panel.
- **Kind**: missing entirely · **Size**: one control

### DG-117 · The Terminal tab has no "Open a terminal for me" in the sample's shape
- **Sample**: the command in a code block, a "Waiting for your yes" chip, then **Open a terminal for me**.
- **App**: the tab exists; its empty state differs.
- **Kind**: layout · **Size**: a component

### DG-118 · Pressing a tab closes the panel
- **App**: with the panel already open, pressing `#aside-toggle` (the only control the tests use) closes it;
  a tab click while the panel is closed does nothing.
- **Sample**: the button toggles, each tab switches.
- **Kind**: interaction · **Size**: one line of code
- **Note**: seen in this walk; worth a builder confirming by hand before treating it as a bug.

### DG-119 · The panel's sections are headings with no content in the empty state
- **App**: "Model / Change the model / What we are doing / Running now / What is allowed right now" with
  three of the five empty once Trunks are on.
- **Sample**: an empty section is one quiet line, not a bare heading.
- **Kind**: layout · **Size**: one line of CSS

### DG-120 · There is no in-page shell to type into
- **Sample**: `[data-act="shell"][data-v="open"]` opens a typeable shell in the Terminal tab.
- **App**: not built.
- **Kind**: missing entirely · **Size**: a feature
- **Owner note** (STATUS-p2-panels.md): *"A typeable shell of your own in the Terminal tab: the sample marks it a proposal; it would be a new way to run commands."*

### DG-121 · The Browser tab shows no live picture
- **Sample**: the tab shows the pages it opened.
- **App**: the pages it opened and its last screenshot.
- **Kind**: layout · **Size**: a component
- **Owner note** (STATUS-p2-panels.md): *"A live picture of the browser: Branch's browser has no live view."*

---

# 7. People and Overview

### DG-122 · Overview has no way in and no page of its own in the window
- **Sample**: Overview is the first row in the sidebar and shows the computer's face and name, a status
  chip, **New conversation · Change look · Settings**, then four panels — **Working on now**,
  **Needs you 3** (each item answerable in place: Yes/No, Review, What is left), **Finished lately**,
  **Schedules**.
- **App**: `overview:here` is a registered tab with no link anywhere in the rail; nothing opened it in this walk.
- **Kind**: missing entirely · **Size**: a feature
- **Owner critique**: #11 ("Overview page empty").

### DG-123 · The People page has no capability list
- **Sample**: each person's card carries six ✓/✗ rows — Look things up · Use web pages · Write files ·
  Run commands · Send messages · Spend money · Change how Branch is set up.
- **App**: one sentence, no list.
- **Kind**: missing entirely · **Size**: a component

### DG-124 · The People page has no Trunks / Projects / Daily allowance / PIN table
- **Sample**: a four-row table at the foot of each card.
- **App**: none.
- **Kind**: missing entirely · **Size**: a component

### DG-125 · People opens on a raw add form, not "+ Invite someone"
- **Sample**: two buttons under the intro — **＋ Invite someone** and **A PIN for switching back to you** —
  and the form behind a dialog.
- **App**: two text fields and "Add someone" inline at the top of the page.
- **Kind**: layout · **Size**: a component

### DG-126 · "Who is using Branch" has no faces (#23, a Keep item)
- **Sample**: the menu lists each person with their face, role and whether they are here now.
- **App**: "The owner / Owner" as plain text, then "People…".
- **Kind**: icon · **Size**: a component
- **Owner critique**: #23 is marked **Keep** — *"Loves 'Who is using Branch' menu — keep (faces added with People update)."*

### DG-127 · "Change look" is missing from a person's card
- **Sample**: each card ends with a pencil and **Change look**.
- **App**: none.
- **Kind**: missing entirely · **Size**: one control

### DG-128 · A composer floats in the middle of the People page
- **App**: "Ask your assistant anything…" with a round send button sits in the middle of People, Inbox and
  the other places.
- **Sample**: no message box on a place page.
- **Kind**: extra in app · **Size**: a component

### DG-129 · People has no eyebrow above the title
- **Sample**: "This computer" in small caps above **People**; "Taofik's Mac" above **Inbox**;
  "TK-1 · Mac computer" above **Taofik's Mac** on Overview.
- **App**: no eyebrow on any place page.
- **Kind**: missing entirely · **Size**: one line of markup

---

# 8. The acorn corner, pets, achievements, backgrounds

### DG-130 · The corner is 270×60 and the acorn is about 30 px
- **Sample**: the acorn is drawn large enough to drag and turn, in the panel's bottom corner, with the pet
  beside it and a "<name> is here" row under them.
- **App**: `#delight-corner` measures 270×60 at 1440 and 1024, the acorn is a ~30 px dithered blob, and
  there is no "<name> is here" row.
- **Kind**: layout · **Size**: a component
- **Owner critique**: #26 is **Keep** ("protect the dithered acorn"); #41 removed its caption but kept it
  in place and gave the pets the corner.

### DG-131 · The corner is gone at 390 px
- **App**: no `#delight-corner` at 390×844.
- **Sample**: the pet and its corner survive to 390.
- **Where**: 390×844. **Kind**: missing entirely · **Size**: one line of CSS

### DG-132 · The pet cannot move and has no name row
- **App**: the pet lives beside the acorn and nowhere else.
- **Sample**: the pet can be dragged to the composer or the rail and its spot is remembered.
- **Kind**: interaction · **Size**: a feature
- **Owner note** (STATUS-p2-delight.md): *"the pet lives beside the acorn in the rail's corner (not movable to the composer or rail, no per-Trunk pets); tips are the real app's own (the sample's mentioned features Branch does not have)."*

### DG-133 · "Show achievements" and "Quiet" are tick boxes
- **Sample**: switches.
- **App**: tick boxes.
- **Kind**: interaction · **Size**: two controls

### DG-134 · "Try a celebration" wraps to two ragged rows
- **App**: six buttons — Bronze · Silver · Gold · Diamond / Godly · SSS+ — break after four, leaving two
  on a second row.
- **Sample**: the ranks sit on one row, or in an even grid.
- **Kind**: layout · **Size**: one line of CSS

### DG-135 · There is no "KeepOak connected" achievement
- **Sample**: named in #49 as one of the ~500.
- **App**: not there.
- **Kind**: missing entirely · **Size**: one record
- **Owner note** (STATUS-p2-delight.md): *"no 'KeepOak connected' achievement (Branch has no KeepOak account link, #14)."*

### DG-136 · "Use my own background" is a tick box
- **Sample**: a switch.
- **App**: a tick box.
- **Kind**: interaction · **Size**: one control

### DG-137 · The background card's labels are technical
- **App**: "Choose a file", "How much the theme's colour covers it (more keeps text easier to read)",
  "How it fits", all in the small monospace label face.
- **Sample**: plain sentence-case labels in the body face, and the scrim slider is a labelled row.
- **Kind**: copy · **Size**: a copy pass

### DG-138 · The 3D is hand-written, not the sample's shapes
- **App**: hand-written WebGL and CSS slabs.
- **Sample**: procedural 3D stand-ins for Trunks, pets, the acorn and the background, with pixel kept alongside.
- **Kind**: layout · **Size**: a feature
- **Owner note** (STATUS-p2-delight.md): *"the 3D is hand-written WebGL, not three.js"*; (STATUS-p2-shell.md) *"3D stand-ins (#46): hand-written CSS (six slabs of the shape in a slowly tilting block)"*.

---

# 9. Places: Inbox, Automations, Library, Customize

### DG-139 · The Inbox mixes its own settings into the list
- **Sample**: the Inbox is rows of things that need you — an icon, a title, a sub-line, and the answers on
  the right (Yes / No / Open the conversation; Keep it / Throw it away; What is left / Dismiss).
- **App**: two filled cards, "Package and tool server requests" (with a dropdown inside it) and
  "Automations waiting for your yes", above the list.
- **Kind**: layout · **Size**: a component

### DG-140 · Place tabs have no counts
- **Sample**: "Needs you 3".
- **App**: "Needs you".
- **Kind**: missing entirely · **Size**: one line of code

### DG-141 · The place breadcrumb is a back button
- **Sample**: "Taofik's Mac [this one] / Inbox".
- **App**: "‹ Conversation | Inbox › Needs you".
- **Kind**: copy · **Size**: a component

### DG-142 · Customize has no Trunks tab
- **Sample**: Customize › **Trunks**, a table of every Trunk with inline edit.
- **App**: Skills · Specialists · Plugins · Connections · Channels.
- **Kind**: missing entirely · **Size**: a component

### DG-143 · Customize is not in the phone's bottom bar
- **Sample**: the phone's bottom bar carries the places.
- **App**: Settings takes Customize's place in the bar; Customize stays in the side list.
- **Kind**: ordering · **Size**: one line of code
- **Owner note** (STATUS-p2-everywhere.md): *"Customize is not in the bar (the sample's bar has Settings in its place); it stays in the side list."*

### DG-144 · The phone's bottom bar is places, not a Trunks strip
- **Sample** at 390: a strip of Trunk and computer faces across the bottom, with the people icon at the right.
- **App** at 390: a places bar.
- **Kind**: layout · **Size**: a component

---

# 10. The usage ring and the popover (#31 — a Keep item)

### DG-145 · The ring is at the bottom, not in the top bar
- **Sample**: a ring with a number in the **top-right** of the top bar, and a separate usage line at the
  bottom of the conversation.
- **App**: one ring at the **bottom-right**, labelled "No limits reported".
- **Kind**: ordering · **Size**: one line of code
- **Owner critique**: #31 is **Keep**.

### DG-146 · The popover is not anchored to the ring
- **App**: the card opens floating over the middle of the conversation.
- **Sample**: it hangs under the ring, right-aligned to the window's edge.
- **Kind**: layout · **Size**: one line of CSS

### DG-147 · The rows have no provider marks
- **Sample**: the ChatGPT, OpenAI, Anthropic, Gemini, OpenRouter and Meta marks, each in its own colour.
- **App**: a generic asterisk glyph in a grey tile.
- **Kind**: icon · **Size**: a component
- **Owner note** (STATUS-redesign-phase1.md): *"Letter tiles instead of provider logos (phase 2, as decided)."*
- **Owner critique**: #21, #30.

### DG-148 · There is no "This month: $…" total in the popover's foot
- **Sample**: "This month: $14.20" on the left, **Open Usage** on the right.
- **App**: only **Open Usage**.
- **Kind**: missing entirely · **Size**: one line of code

### DG-149 · The per-window bars are missing
- **Sample**: each measured connection shows its windows — "This 5-hour window · 12% left · resets at 6 pm"
  and "This week · 64% left · resets Monday" — each with a filled bar, and an "as of …" line saying where
  the number came from.
- **App**: the state chip and one sentence.
- **Kind**: missing entirely · **Size**: a component

---

# 11. The mode picker (#20)

### DG-150 · The modes are in a different order and are named differently
- **Sample**: Auto · Ask first · Plan first · No approvals · **Lockdown**.
- **App**: Ask first · **Plan** · Auto · **Full access** · **Use my setting**.
- **Kind**: ordering / copy · **Size**: a copy pass plus one line of code

### DG-151 · Lockdown is not in the mode menu
- **Sample**: the last row, with a red shield, "Refuses all commands and risky actions."
- **App**: not there; Lockdown is in the More menu.
- **Kind**: missing entirely · **Size**: one row

### DG-152 · The number keys are not shown
- **Sample**: a small `1` `3` `4` chip on the right of each row.
- **App**: none.
- **Kind**: missing entirely · **Size**: one line of markup

### DG-153 · The footer that explains where the other choices are is missing
- **Sample**: two lines under the list — "New conversations start on Ask first. Branch's own setting
  (Settings › Permissions) is still No approvals." and "Shift+Tab in the message box moves to the next
  mode. More choices (Just do it inside my workspace, Read only) are in Settings › Permissions."
- **App**: a row "Use my setting / Currently: No approvals" instead.
- **Kind**: copy · **Size**: a copy pass

---

# 12. The terminal and phone frames (#44, #53)

### DG-154 · There is no in-window terminal / phone / tablet preview
- **Sample**: a dialog, **Branch in the terminal and on your phone**, with four tabs — Terminal · iPhone ·
  Android · Tablet — a real in-page TUI you can type into, and true-proportion phone and tablet frames
  that share the desktop's state.
- **App**: the terminal and phone layouts are real (`src/terminal-*.ts`, `public/phone-layout.js`) but
  there is no way to look at them from the window.
- **Kind**: missing entirely · **Size**: a feature

### DG-155 · The terminal's key hints line differs
- **Sample**: "Enter sends · Alt+Enter adds a line · Up recalls · Ctrl+E shows step details · Ctrl+C stops
  the task · Ctrl+D leaves" and "Esc, then 1-5 (or Alt+1 to Alt+5): Conversation, Inbox, Automations,
  Library, Customize · Ctrl+K or /: find anything".
- **App**: the terminal view has a key line; its wording is its own.
- **Kind**: copy · **Size**: a copy pass

### DG-156 · Answers are headed by the assistant's name in the app, "Branch Agent" in the sample's frame
- **App**: "<assistant name>:" instead of "Assistant:".
- **Sample**: the assistant's own name with its face.
- **Kind**: copy · **Size**: one line of code
- **Owner note** (STATUS-p2-everywhere.md): *"Answers are headed '<assistant name>:' instead of 'Assistant:' (tests/cli-tui.test.mjs regexes updated)."*

---

# 13. Things that are already right

Worth saying, so nobody spends time on them:

- **No sideways scroll anywhere.** 1440, 1024 and 390, every scene walked, both sides: 0 px. #52 and #62
  are held.
- **The Add a Trunk studio** keeps the sample's shape: one dialog, one tab strip that stays, the same
  shapes, the same live preview panel. #34's Keep is honoured apart from DG-104 to DG-110.
- **The theme gallery, the mirrors and the level control** all exist and work.
- **The acorn is the pixel one**, not a plain acorn (#57's regression is not in the app).
- **Slate is the default theme** (#56).
- **The "Keep Branch up to date by itself? Recommended" bar** is there, with Yes / Not now / Don't ask
  again (#43's Keep).
- **The achievements system** is there, 505 of them, with ranks (#50).

---

# 14. A plan, in batches

Ordered by how visible each batch is to the owner. "Cheap" means CSS and copy only; "real work" means new
product.

| # | Batch | Gaps | Rough count | Cost |
|---|---|---|---|---|
| 1 | **Every switch becomes a switch; every three-way becomes `Off / When needed / On`; every choice list becomes the glass dropdown** | DG-015 to DG-018, DG-021, DG-022, DG-054, DG-106, DG-133, DG-136 | 10 rows, ~400 controls | **Cheap-ish**: one switch renderer, one segmented renderer, wire `glass-select` to the 294 selects, `accent-color` on ranges. No new product. |
| 2 | **The message box** — one slim bar, chips that collapse to marks, the tick boxes out, Send never wraps | DG-084 to DG-089, DG-101 | 7 | **Cheap** (CSS and moving two controls), except the model chip's provider mark, which needs the marks from `brand-marks.js`. |
| 3 | **Settings page furniture** — back link, title, version line, "On this page", one column, no scope chips, heading levels, the Esc chip | DG-001 to DG-003, DG-006, DG-008 to DG-013, DG-063, DG-064, DG-071 to DG-076, DG-078 | 19 | **Cheap**: CSS and one jump-link renderer. |
| 4 | **Words** — jargon out, the three-way wordings, section names, achievement wording, the mode picker's names, order and footer | DG-019, DG-023, DG-032, DG-050, DG-077, DG-137, DG-150, DG-152, DG-153, DG-155 | 10 | **Cheap**: a copy pass across the locale files (en + fr). |
| 5 | **Hover explanations** (#29) — the ⓘ control and an entry per control | DG-007 | 1 row, 356 entries | **Cheap component, long tail**: one component plus a data pass; `settings-descriptions.js` already holds 186 of them. |
| 6 | **The rail and the sidebar** — the computer header, Conversations/Trunks tabs, Overview's row, the theme row, the owner row, the Trunks heading, faces in "Who is using Branch" | DG-090 to DG-095, DG-097, DG-102, DG-103, DG-126, DG-129 | 11 | **Mixed**: DG-095, DG-103 and DG-129 are one line each; the rest is a component. |
| 7 | **Permissions and the mode picker as choice cards**, Lockdown back on the page and in the menu | DG-020, DG-024, DG-048, DG-049, DG-151 | 5 | **Component work**, no new product. |
| 8 | **The usage ring and popover** (#31, a Keep) — ring to the top bar, anchor the card, provider marks, the month total, the per-window bars | DG-145 to DG-149 | 5 | **Mixed**: marks and the anchor are cheap; the per-window bars need the real numbers `usage-glance.ts` already has. |
| 9 | **The side panel** — labels back on the tabs, "Side panel" title, the auto-open switch, the empty states | DG-114 to DG-119, DG-121 | 7 | **Cheap** apart from DG-118, which may be a real bug. |
| 10 | **The studio's remaining gaps** — colours, Starts in, the header preview, the tab, the strip labels | DG-104 to DG-110, DG-112, DG-113 | 9 | **Mixed**: colours and labels are cheap; the KeepOak tab needs #14. |
| 11 | **Appearance** — Day or night, the eye, the theme search, the filter chips, tile size, the Branch theme, the mirrors | DG-033 to DG-040 | 8 | **Component work**. |
| 12 | **Places** — the Inbox's shape, tab counts, the breadcrumb, Customize's Trunks tab, the floating composer off place pages | DG-100, DG-128, DG-139 to DG-144 | 8 | **Mixed**. |
| 13 | **The corner, the pets and the celebrations** | DG-130 to DG-134, DG-138 | 6 | **Cheap** apart from DG-138 (3D). |
| 14 | **People and Overview** — the capability list, the table, Change look, Invite someone, and giving Overview a way in | DG-092, DG-122 to DG-125, DG-127 | 6 | **Real product work**: Overview is a whole page with no way in today. |
| 15 | **Secrets and Accounts** — the list with marks, the password-manager row, the accounts list and Add an account | DG-045, DG-046, DG-052, DG-053 | 4 | **Real product work**, and DG-053 needs the password-manager states. |
| 16 | **The seven missing Settings pages**, pinning, and the 96 unindexed settings | DG-004, DG-005, DG-058 to DG-062, DG-067, DG-068, DG-069, DG-079, DG-083 | 12 | **Real product work**, and the biggest of the lot. |
| 17 | **KeepOak** (#14) — the account card, the studio tab, the achievement | DG-027, DG-104 (part), DG-135 | 3 | **Real product work**: Branch has no KeepOak account link at all. |
| 18 | **The terminal and phone frames in the window** (#44, #53) | DG-154 to DG-156 | 3 | **Real product work**. |
| 19 | **The rest of the conversation screen** — the breadcrumb, the top-bar search, the open-conversations strip, the guide lightbulb | DG-096, DG-098, DG-099 | 3 | **Mixed**: the strip and the guide are features. |
| 20 | **The remaining Settings page-by-page gaps** | DG-025 to DG-031, DG-041 to DG-044, DG-047, DG-051, DG-055 to DG-057, DG-065, DG-066, DG-070, DG-080 to DG-082 | 24 | **Mixed**, mostly component work. |

**Batches 1 to 5 are almost all CSS and copy** and between them close 47 gaps — including the two the
owner will notice first (every control being the wrong kind, and the message box). **Batches 14 to 18 are
real product work** and should be planned, not squeezed in.
