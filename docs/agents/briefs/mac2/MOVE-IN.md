# mac2/move-in: bring your old assistant with you

Area `move-in`. Read `docs/agents/briefs/mac2/README.md`. You own new files `src/migrate/*.ts`,
`public/move-in.js` (add to the static allowlist in `src/server.ts`), `src/migrate-api.ts` with one route block,
and tests.

Import from Hermes Agent, OpenClaw, Claude Code, Codex CLI and OpenCode: find each one's home folder (or accept a
folder/zip/tar), show a read-only preview first (chats, projects, memory, instructions, skills, MCP servers,
settings), let the owner tick what to bring, then import into Branch's own stores. Never import credentials or
hidden reasoning; map secrets to "add this key in the locker" prompts instead. Keep a record so nothing is
imported twice. Plain-language first-run offer: "Bring your chats and memory from …".
Study Agent Zero `plugins/_migrate_agents/` (MIT), OpenFang `crates/openfang-migrate/` (MIT/Apache), Codex
`codex-rs/external-agent-migration/` (Apache-2.0), Goose `crates/goose/src/session/import_formats/` (Apache-2.0),
and the real on-disk formats in the clones. Tests use fixture folders only; never read the owner's real
~/.claude, ~/.codex or Hermes data.
