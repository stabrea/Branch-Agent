# mac3/security-check: a security self-check with fixes, and a malware check on add-ons (GAPS.md top 10 #10)

Area `security-check`. Rules: BUILD-MAC.md, mac2/README.md, mac3/DESIGN-EVERYWHERE.md. **You own:** new
`src/security-audit/**`, `src/doctor-fix.ts` (additive hook), a card at `settings:permissions` (or where places.md puts
it), `branch security audit [--fix]` in the CLI (small, marked), tests.
1. **Audit:** ~80 named checks in plain words, each with an optional one-click fix: config/secret/log files readable by
   others (chmod on macOS/Linux, icacls on Windows), data folder inside iCloud/Dropbox/OneDrive/Google Drive, remote
   access without a password, plugins without integrity pinning, weak or tiny models with web tools on, risky sandbox
   choices, leak-guard off with channels on, etc. Study OpenClaw `src/security/audit.ts`, `audit-extra.*.ts`, `fix.ts`,
   `windows-acl.ts` (MIT).
2. **Malware check:** before an `npx`/`uvx`/`pipx` MCP server or add-on starts, look the package up in OSV
   (osv.dev API, through the network policy) and refuse a known-malicious one with a plain sentence; cache results.
   Study Goose `crates/goose/src/agents/extension_malware_check.rs` (Apache-2.0). Fake OSV server in tests.
