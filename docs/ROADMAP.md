# Roadmap

Where Branch Agent is, what ships next, and what "done" means. Numbers come from the capability ledger (`docs/audit/`), counted the honest way: an item counts only when a reviewer has named the code and the test.

## Where we are (17 September 2026)

- Released: 0.15.0. Installed and self-updating silently on the owner's PC since 0.7.3.
- Ledger: 786 pieces of work in the audit. 255 single items verified, 143 grouped rows done, 23 grouped rows not applicable. Honest remaining: 355 (311 single items open plus 44 grouped rows partial or not done).
- Loop: five to seven Opus agents at all times, one release per wave, every branch reviewed before it lands. See `docs/agents/README.md`.

## Next releases

**0.16.0 (in progress).** Realtime voice (talk and interrupt over a live connection), hardening pass 2 (embeddings behind the network policy, several approvals at once, unguessable webhook addresses, study concurrency), the long tail (lockdown mode, request cache, project defaults, thread tree, `branch watch`), the design QA pass (every screen, both themes, 400 px), and the re-opened rows (Bitwarden and 1Password lookups, sandbox choice per rule, fail-closed commands, profile roles, blocking hooks, supervisor/swarm/handoff patterns).

**0.17.0.** Web UI pass 3 (artifacts, flow editor, charts, reports, to-dos, Obsidian bridge, widget and extension), the remaining secrets/tracing/CLI rows (short-lived tokens, secret providers, OTLP logs, installed coding-agent CLIs as model backends, npm-packed CLI), real sandboxes where the computer has one (Docker, WSL, Windows Sandbox), SSH workspaces, documents pass 3 (write Office files, pictures as documents, knowledge graph, summaries), and the owner's handbook with in-app help.

**0.18.0.** Whatever the ledger still shows open after 0.17 and worth building for a single-owner Windows desktop assistant: the remaining orchestration rows, evaluation environments that can run without a VM, memory and document leftovers, and a third verification pass over everything ticked since the second.

## What "1.0" means

1. Every remaining ledger row is either verified, documented as not applicable with a reason, or listed in `docs/handbook/10-what-branch-is-not.md`.
2. Code signing for the Windows build so Smart App Control stops warning (needs a certificate the owner buys; tracked in issue #12/#18).
3. The in-app "open KeepOak" entry, only if it can be done without exposing the website's source (issue #19); moving the repository to the KeepOak organisation is the owner's call (issue #20).
4. A third-party security review of the approval gate, the secrets vault, the network policy, the borrowed browser and the MCP surface.
5. Docs a non-technical person can follow end to end (the handbook), and a first-run that gets to a first answer in under two minutes with a local model.

## Standing rules

- No feature ships without a test that asserts its behaviour and a reviewer who read it.
- Nothing leaves the computer that the owner did not switch on, and every switch says in plain words what it sends where.
- Every release rehearses its own update path from the previous version before it is published.
- Community pull requests get a decision and a thank-you, every time.
