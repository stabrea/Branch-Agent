# mac3/tool-safety: smarter approvals (GAPS.md top 10 #6–#7)

Area `tool-safety`. Rules: BUILD-MAC.md, mac2/README.md, mac3/DESIGN-EVERYWHERE.md. **You own:** `src/policy.ts`,
`src/policy-resources.ts`, `src/approvals.ts` (additive), new `src/approval-reviewer.ts`, cards at `settings:permissions`, tests.
The merged loop guard and folder trust (`src/loop-guard.ts`, `src/folder-trust.ts`) and leak-guard hooks stay intact.
1. **"Always allow" per subcommand:** remembered command approvals match by a command prefix that knows how many words
   define each program's action (`git status` ≠ `git push`, `npm run dev` ≠ `npm install`), with a table like
   OpenCode `packages/opencode/src/permission/arity.ts` (MIT); `policyTarget` gives `shell.session.run` a real target.
2. **A second model reviews risky or unknown calls:** a switchable reviewer (three-way, off by default) that decides
   read-only vs changing for tools that do not say (MCP tools especially), and reviews risky calls against the owner's
   plain-English rules before the approval card: allow (read-only), ask (changes), or deny with a reason; the owner can
   overrule a denial once. Study Goose `crates/goose/src/permission/permission_judge.rs`, `security/adversary_inspector.rs`
   (Apache-2.0), Codex `codex-rs/core/src/guardian/*` (Apache-2.0). Offline demo provider in tests.
