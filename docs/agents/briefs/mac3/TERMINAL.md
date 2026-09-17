# mac3/terminal: the terminal view in the Branch design

Area `terminal`, branch `mac3/terminal` from `mac/cross-platform`. Read `docs/agents/briefs/mac3/DESIGN-EVERYWHERE.md`,
`docs/agents/briefs/mac1/BUILD-MAC.md`, `docs/agents/briefs/mac2/README.md`.
**You own:** `src/terminal.ts`, `src/terminal-tui.ts`, `src/terminal-style.ts`, `src/terminal-input.ts`,
`src/terminal-commands.ts`, new `src/terminal-theme.ts`, their tests, and the terminal section of `docs/configuration.md`.

1. **Theme:** the terminal palette comes from the same 44 themes (light and dark) — map each theme's tokens to
   truecolor, 256-colour and 16-colour fallbacks (detect `COLORTERM`, `TERM`, `NO_COLOR`, `FORCE_COLOR`); `branch
   theme <name>` and the Settings theme choice are the same setting.
2. **Layout like the window:** a header with the Branch mark and the current place; the five places as a tab row
   (keys 1–5 and a command palette on `Ctrl+K`/`/`), Conversation as the main view with the side pane (plan, details)
   togglable; Inbox (needs you / finished / history), Automations, Library and Customize as readable lists with the
   same labels; Settings pages reachable by name. Resize-safe, works at 80×24, mouse optional.
3. **Plain words** from `public/locales/*.json` keys (a small loader); French when the setting says so.
4. **Parity checks:** a test that every place and Settings page in `docs/places.md` is reachable from the terminal, and a
   snapshot test of each view at 80×24 and 120×40 in each colour depth.
Study Codex CLI (`codex-rs/tui`, Apache-2.0), OpenCode (`packages/opencode` TUI, MIT) and Gemini CLI (`packages/cli`, Apache-2.0)
for layout and input handling; borrow with notices.
