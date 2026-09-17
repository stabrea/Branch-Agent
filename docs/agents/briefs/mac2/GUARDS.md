# mac2/guards: stop loops, read the folder's own instructions, and trust folders first

Area `guards`. Read `docs/agents/briefs/mac2/README.md`. You own new files `src/loop-guard.ts`,
`src/instruction-files.ts`, `src/folder-trust.ts`, their tests, and one hook each in `src/runtime.ts`
and wherever project instructions are assembled (find it; keep the edit small).

1. **Loop guard** (audit A1769 is marked done but no code exists; A1713): detect the same tool with the same
   arguments repeated (faster when the result is also identical) and A-B-A-B ping-pong; warn the model, then
   block the call, then stop the run with a plain sentence; gentler limits for tools meant to be polled.
   Study OpenFang `crates/openfang-runtime/src/loop_guard.rs` and Gemini CLI `packages/core/src/services/loopDetectionService.ts`.
2. **Instruction files** (A0689 marked done but its evidence files do not exist; A0111, A0042, A0219): read
   `AGENTS.md`, then `CLAUDE.md`/`GEMINI.md` as fallbacks, from the workspace root down to the folder a task works in;
   a subfolder's file loads the first time the task touches that folder; `@path.md` imports up to 5 levels with a
   cycle guard; size caps; `.branchignore`/gitignore respected. Study Gemini CLI `memoryDiscovery.ts`,
   `memoryImportProcessor.ts`, Goose `crates/goose/src/hints/`.
3. **Trusted folders**: before a new workspace folder's instruction files, hooks, MCP servers or skills are loaded,
   the owner sees the list and chooses trust / don't trust; untrusted folders load none of it and the approval mode
   falls back to "ask". Study Gemini CLI `packages/core/src/utils/trust.ts`, `FolderTrustDiscoveryService.ts`.
   Plain-language card in the UI in its own `public/folder-trust.js` (add it to the static allowlist in `src/server.ts`).
Tests for each, including the three audit ids' behaviour.
