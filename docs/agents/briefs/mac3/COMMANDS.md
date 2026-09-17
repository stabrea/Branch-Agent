# mac3/commands (starts after mac2/chat-live and mac3/terminal merge): one slash-command catalog everywhere

One source of truth for `/commands` (new `src/commands/catalog.ts`): name, aliases, plain description (locale key),
arguments, which surfaces offer it (window composer, terminal, chat apps, phone), permission needed, and the action it
maps to (an existing route or runtime call). Every surface reads that catalog: the composer's `/` menu, the terminal,
chat apps (`/help` lists only what that surface can do), the phone app. Parity table with Hermes Agent, OpenClaw,
Claude Code, Codex CLI, Gemini CLI and OpenCode commands: each mapped to a sensible Branch action or marked not
applicable with a reason. Tests: every command in the catalog resolves to a real action on every surface it claims;
`/help` output per surface; no surface has a hard-coded command list left.
