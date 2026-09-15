# Branch Agent checkpoint — 2026-09-15

## Paused at the user's request

The user asked: "ok pause here as your usage will soon finish so checkpoint".
Stop implementation after saving this checkpoint. Resume when the user asks.
The overall build is unfinished; do not mark the active goal complete or blocked.

## Workspace and delivery

- Worktree: `C:/Users/bishi/Documents/Codex/Branch-build`
- Branch: `feat/assistant-runtime`
- Remote: `https://github.com/stabrea/Branch-Agent.git`
- Draft PR: https://github.com/stabrea/Branch-Agent/pull/1
- Last pushed revision before this batch: `3a732236dbb892b788508dca315ed9cf891ef0f2`.
- Skills UI local commit: `a4b3fc1`.
- This checkpoint commit contains the corresponding core, tests and pinned YAML dependency.
- These skills changes have not been pushed, packaged or reviewed yet.

KeepOak's logo and interactive rotating acorn are already present in Branch Agent.
KeepOak.com was not modified. Preserve those assets and the Branch Agent name.

## Current skills implementation

Added single-file `SKILL.md` import/creation, immutable document versions, explicit
activation/rollback, disable/remove, owner-scoped SQLite persistence, and optimistic
revision checks. Editing leaves the active version unchanged until activation.
Documents are preserved exactly, including notices and line endings.

The runtime includes enabled skill metadata in the initial request, then loads full
documents only through `skills.read`. Each run snapshots its advertised versions.
Editing, switching or disabling a skill does not change an existing run's snapshot;
removal prevents subsequent reads. Skill metadata never grants tool permissions.

Files:

- `src/skill-document.ts`: YAML/frontmatter validation and request schemas.
- `src/skills.ts`: `InstalledSkills` storage, owner boundaries, revisions and limits.
- `src/skill-tools.ts`: metadata discovery, run snapshots, `skills.list`, `skills.read`.
- `src/store.ts`, `src/index.ts`, `src/runtime.ts`, `src/server.ts`: integration.
- `public/app.js`, `public/index.html`, `public/style.css`: Skills view.
- `tests/skills.test.mjs`, `tests/skills-ui.test.mjs`: core and browser coverage.
- `package.json`, `package-lock.json`: exact production dependency `yaml@2.9.1` (ISC).

Bounds: 50 installed skills per owner, 20 enabled, 20 retained versions per skill,
24 KiB encoded enabled catalog, documents <=16000 JS characters and <=48 KiB UTF-8,
8192-character frontmatter, <=60000-character encoded document plus metadata.
Only single-file instructions are imported; bundled scripts/assets/references are
not installed. This is not complete Agent Skills package support.

### API contract

- `GET /api/state`: adds metadata-only `skills` summaries.
- `GET /api/skills/:id`: head document and retained version summaries.
- `POST /api/skills/install`: `{document}`; installs and activates v1.
- `POST /api/skills/:id/update`: `{document,expectedRevision}`.
- `POST /api/skills/:id/activate`: `{version,expectedRevision}`.
- `POST /api/skills/:id/disable`: `{expectedRevision}`.
- `POST /api/skills/:id/remove`: `{expectedRevision}`.
- `POST /api/skills/:id/read`: `{version}`; explicit human UI document read.
- Model `skills.list`: `{}` => metadata catalog.
- Model `skills.read`: `{id,version}` => `{id,version,metadata,document}`.
- Both model tools require `skills.read`; no model authoring tools in this batch.

## Verified in this batch

- `npm run build`: passed after core integration and again with final parser bound.
- `node --test tests/skills.test.mjs`: 8/8 passed.
- UI worker ran skills browser tests plus existing UI regression: 6/6 passed.
- Real-task browser fixture verifies metadata-only initial discovery and exact selected
  v2 document delivery after a `skills.read` call.
- Core tests verify owner isolation, restart persistence, conflict handling,
  transactional rollback, all capacity limits, no permission expansion, and pinned versions.
- UI worker verified 390px layout, inspected screenshot and checked new UI function lengths.
- Screenshot: `C:/Users/bishi/AppData/Local/Temp/Codex-session-files/branch-skills-ui-20260915.png`.

These are targeted tests, not a fresh full-suite or packaged desktop pass.

## Next actions after resume

1. Inspect current diff/HEAD and this checkpoint; do not rebuild existing work from scratch.
2. Complete spec review, then quality review of skills core and UI. Fix findings and re-review.
   Pay attention to run snapshot semantics, removal, request/response bounds, YAML handling,
   authorization, rollback and UI drafts. Run the existing function-length checker on core.
3. Run the full app suite after reviews settle; add meaningful missing regressions if found.
4. Update documentation and evaluate only `extensions.progressive` and `extensions.authoring`
   against their actual acceptance criteria; do not imply bundled package support.
5. Repackage desktop, regenerate dependency notices (including YAML), run native checks,
   update archive validation required modules, produce ZIP/hash, and verify contents.
6. Commit final reviewed changes, push existing feature branch, update draft PR and verify CI.
7. Continue the original feature inventory; full product remains far from complete.

Existing review agents can be reused: `branch_core_spec`, `branch_core_quality`,
`branch_desktop_spec`, `branch_desktop_quality`, `branch_coverage_review`.
UI implementer `branch_terminal_impl` finished and committed its owned files.
No known live shell process requires polling or termination at this checkpoint.

## Baseline before skills changes

- Inventory: 169 entries; 19 implemented, 53 partial, 1 external, 96 missing.
- Full suite: 178 passed, 1 skipped (Windows volume lacks 8.3 aliases).
- Packaged desktop tests: 8 passed; Python tests: 16 passed (earlier batch).
- Existing ZIP: `release/Branch-Agent-windows-x64.zip`, 168246174 bytes, 4052 files.
- Existing ZIP SHA256: `f715c4dc5030805a4b86c86ccb1ae1a3a4e39ef31b9e9f44caeee9fe93782c14`.
- Existing ZIP includes identity/memory/session capabilities, not the new skills work.
- Last known CI runs for `3a73223`: `35017775524`, `35017772101`; check fresh state on resume.
- No full feature parity, AGI, sentience or measured token-savings claim is established.

## Supporting paths and references

- External inventory/assessment: `C:/Users/bishi/Documents/Codex/branch-build-research/`.
- Scratch/tool scripts: `C:/Users/bishi/AppData/Local/Temp/Codex-session-files/`.
- Public coverage generator: `branch-public-coverage.py` under scratch directory.
- Archive builder: `branch-agent-archive.py` under scratch directory.
- Function checker: `branch-function-check.mjs` under scratch directory.
- PR body: `branch-agent-pr.md` under scratch directory.
- Format: https://agentskills.io/specification
- Parser: https://eemeli.org/yaml/

Use Git Bash explicitly from the PowerShell tool. Preserve other contributors' edits.
Keep functions under 50 lines, TypeScript strict, and test before commits. Store scratch
files only under the session temp directory. Never modify KeepOak.com for this project.
