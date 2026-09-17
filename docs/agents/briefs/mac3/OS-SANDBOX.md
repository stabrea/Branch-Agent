# mac3/os-sandbox (starts after mac1/processes merges): a real wall around programs on macOS and Linux

Area `os-sandbox`, branch `mac3/os-sandbox` from `mac/cross-platform`. Rules: BUILD-MAC.md, mac2/README.md,
mac3/DESIGN-EVERYWHERE.md. **You own:** `src/sandbox.ts`, `src/sandbox-backends.ts`, new `src/sandbox-seatbelt.ts`,
`src/sandbox-bwrap.ts`, `src/sandbox-proxy.ts`, `src/sandbox-denial.ts`, the network-approval hook where programs are
started (small, marked), a card at `settings:permissions` (or the Firewall card's home per `docs/places.md`), tests.

Today macOS/Linux programs get resource limits only: they can read and write anything the owner can, and "no internet"
is a proxy setting a program can ignore. Build (audit rows A0019, A0050, A0076, A0154, A0454, A1911, A1958, A2020, A2052):
1. **macOS:** `/usr/bin/sandbox-exec` (absolute path) with a `(deny default)` profile: writes only inside the workspace
   (and temp), `.git`, `.branch`, `.agents` read-only, secret locations unreadable, network denied unless allowed; paths
   passed as `-D` parameters, never pasted into profile text. Study Codex `codex-rs/sandboxing/src/seatbelt.rs` + the
   `.sbpl` files and Gemini CLI `packages/core/src/sandbox/macos/*` (both Apache-2.0).
2. **Linux:** bubblewrap (`bwrap`) when present: `--ro-bind / /`, bind the workspace writable, re-bind `.git` etc
   read-only, `--unshare-user --unshare-pid`, `--unshare-net` when network is off, fresh `/proc`, `--die-with-parent`;
   a seccomp filter written in Node (as Gemini CLI does) blocking ptrace and, with network off, socket families other
   than AF_UNIX. Clear "bwrap is not installed / user namespaces are off" message when unavailable. Study Codex
   `linux-sandbox/src/bwrap.rs`, `landlock.rs` and Gemini CLI `packages/core/src/sandbox/linux/*`.
3. **Per-site network:** when network is allowed "per site", programs go through a local HTTP/SOCKS proxy that the
   sandbox forces; a request to a new host pauses the task with "allow github.com?" (once / always for this
   conversation / always), using the existing approval card; "limited" mode allows only GET/HEAD. Study Codex
   `codex-rs/network-proxy/*`.
4. **Denials explained:** when a command fails because the sandbox blocked it (exit signature + stderr keywords), the
   task gets a plain "the sandbox blocked writing to X — allow once?" instead of the model guessing; one retry with the
   narrowest widening. Study Codex `sandboxing/src/denial.rs`, Gemini CLI `sandboxDenialUtils.ts`.
5. **Tighten-only is preserved** across rules and sandbox choice; three-way switch, off by default ("when needed" =
   sandbox only commands the policy marks risky). Windows keeps its job object / Windows Sandbox paths unchanged.
Tests: profile/argument generation per platform (pure); a real `sandbox-exec` run on this Mac that proves a write
outside the workspace is refused and inside is allowed (no window, temp folders only); a real `bwrap` run on
branch-test-linux (install `bubblewrap` there with apt if missing — allowed for this brief) proving the same and that
network is cut; proxy tests with a local fake server only.
