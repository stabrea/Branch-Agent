# Wave mac3: one design everywhere

The owner's instruction: **every surface of Branch follows the one design Legion shipped in wave 9** — the window,
the terminal, the phone apps, the web dashboard, installers, notifications, the Stop banner. Read `docs/design.md`
and `docs/places.md` first, every time. Concretely:

- **Colours only from `public/tokens.css`** (and `public/theme-catalogue.js` for the 44 themes); a surface that cannot
  read CSS (terminal, native notification, installer) derives its palette from those same values by a small shared
  function, never by typing colours.
- **The five places** (Conversation, Inbox, Automations, Library, Customize) and the Settings pages are the map on every
  surface. A surface that cannot show all of them shows a subset in the same order with the same names.
- **Words:** the same plain-language labels, from `public/locales/en.json` / `fr.json` keys wherever the surface can
  read them; French is real French.
- **The oak (`public/grove.js`) and the KeepOak mark** as `docs/design.md` describes; no KeepOak website source is ever
  copied into Branch (public repo).
- Everything new ships behind the three-way switch, off by default. The owner does not want to be asked; decide and report.
