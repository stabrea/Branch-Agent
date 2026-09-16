# Wave 2 task: workspace search and code editing tools

Rules: docs/agents/briefs/wave1/BUILD.md. Branch: wave2/code-tools from origin/feat/assistant-runtime. Themes: codebase-search (#86), file-and-code-tools (#81). No UI work beyond what already exists (the shell is being redesigned on another branch). Everything is tools + runtime + tests + docs.

Read: src/files.ts (existing file tools, workspace confinement), src/history.ts / workspace history (undo), src/registry.ts, src/contracts.ts (permissions), tests/files*.test.mjs.

Build, all inside the workspace confinement and permission gates that already exist:
1. `files.glob` — list files matching glob patterns (implement matching with Node built-ins: path.matchesGlob if available in Node 24, else a small matcher), honouring a `.branchignore`/`.gitignore`-style ignore file (A0435) plus the existing secret patterns; bounded results with "more available" flag.
2. `files.grep` — regex/literal search across files with context lines, file globs, case option, max results and max file size; skips binaries; returns path:line:text with a stable shape.
3. `files.patch` — apply a unified diff (multi-file, with fuzz 0; hunks must match exactly or the whole patch is refused with a precise message naming the file and hunk) and `files.edit` — exact string replacement with `expectedOccurrences` (default 1) that refuses ambiguous matches. Both record workspace history so undo works, and both return the resulting diff summary.
4. `files.validate` — after a write/patch, optional syntax validation for .json (parse), .js/.mjs/.ts (use `node --check` for JS via the existing shell runner; for TS use the TypeScript compiler API only if it is already a dependency, otherwise skip with a note) and report problems as data, not as failures.
5. `workspace.map` (light repository map, A0334/A0537): a bounded tree of the workspace with per-file size, language guess and, for .js/.ts/.py/.md, the top-level symbols or headings found by simple regexes (no tree-sitter). Cached per file mtime.
6. Fuzzy path search for the UI later: `files.find { query }` scoring path segments (simple subsequence + boundary bonus), top 20.

Tests (tests/code-tools.test.mjs): glob + ignore file; grep with context and binary skip; patch success, patch refusal on mismatch with hunk named, multi-file patch atomicity (all or nothing); edit ambiguity refusal; validate reports a JSON syntax error; map shows symbols and honours the cache; fuzzy find ordering; confinement (a path outside the workspace is refused by every tool); permission gating (write tools need files.write).

Acceptance: T1 six tools registered and described in plain language in the catalog; T2 patch is atomic; T3 undo works after patch/edit (existing history mechanism); T4 confinement proven per tool; T5 docs/configuration.md lists the tools with one-line descriptions; T6 all existing files tests still pass.
