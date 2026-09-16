# Wave 4 task: skills and plugins people can actually share

Rules: docs/agents/briefs/wave1/BUILD.md. Branch: wave4/skills-plugins from the local branch wave2/integration. Themes: skills-and-recipes (#78), plugin-and-extension-system (#70). Backend plus the existing Skills screen (small additive changes).

Read: src/skills*.ts, src/skill-scan.ts, src/skill-governance.ts, src/registry-install.ts, src/recipes*.ts, src/templates.ts, src/hooks.ts, src/mcp*.ts, docs/configuration.md sections on skills, tests/skills*.test.mjs, tests/teams-registry.test.mjs.

Build:
1. Skill packages: a folder format `skill/` with SKILL.md, optional `tools.json` (declarative HTTP tools: name, description, method, url template, headers from locker secrets, input schema, output pick) and optional `hooks.json` (events → recipe), packed to a single `.branchskill` (zip built with node:zlib, no dependency) with a manifest (name, version, author, permissions requested, sha256 of every file). Import/export routes and CLI (`branch skill pack|install <file>`); install runs the existing scan and shows the requested permissions for approval; declarative HTTP tools run under the network policy and never see secrets in the model context.
2. Registry v2: the existing JSON registry gains versions, changelogs, signatures (ed25519 with node:crypto; a registry publishes its public key once; unsigned entries are labelled), update checks ("2 skills have updates"), and one-click update with rollback to the previous version (skills already have versions).
3. Skill authoring help: `POST /api/skills/draft-from-runs` (extends the existing draft from one run) that proposes a skill from several similar successful runs; a "test this skill" action running its examples with the scripted or real model and a report.
4. Plugin surface for developers: a documented `BranchPlugin` interface (register tools, hooks, channel adapters, panels are NOT allowed) loaded from `plugins/*.mjs` in the data dir, opt-in per plugin with a permission summary, sandboxed only by permission gating (say so plainly in docs); a `branch plugin list|enable|disable` CLI.
5. Marketplace-free discovery: `GET /api/skills/suggest` uses the owner's recent runs to suggest which built-in or registry skills would have helped (keyword match, no model call), surfaced in the Skills screen.

Tests (tests/skills-plugins.test.mjs): pack/unpack round trip with hash check; tampered package refused; declarative HTTP tool runs against a fake server with a locker secret header and the secret never appears in results/events; signed registry entry verified and a bad signature refused; update with rollback; draft-from-runs; plugin load/enable/disable with a fake plugin file and permission gating; suggestions.

Acceptance: K1 package format documented and round-trips; K2 signatures proven both ways; K3 secrets never reach the model (test); K4 plugins opt-in only; K5 docs/configuration.md sections; K6 no new dependency. Report the ids you consider done.
