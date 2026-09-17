# mac2/leak-guard: keys never leave by accident

Area `leak-guard`. Read `docs/agents/briefs/mac2/README.md`. You own new `src/leak-guard.ts`, its tests, one hook
where provider requests are sent and one where tool results are returned (keep both edits small), and the
secret-filename pattern in `src/files.ts`.

1. Scan every request to a model service and every tool result for anything shaped like a credential (OpenAI,
   Anthropic, AWS, GitHub, Slack, JWTs, private-key blocks, `password:`/`Authorization:` values, `user:pass@` URLs),
   including ones Branch never looked up; redact in tool results and in the model request, record a plain
   "a key-like value was hidden" event without the value. Study IronClaw
   `crates/substrates/ironclaw_safety/src/leak_detector.rs` (MIT OR Apache-2.0).
2. Refuse a web fetch whose URL carries `api_key=`, `token=`, `password=` unless the owner approves; study OpenFang
   `tool_runner.rs check_taint_net_fetch`.
3. Widen the file tools' refused credential locations: `.netrc`, `.npmrc`, `.pypirc`, `.docker/`, `.kube/`,
   `gh/hosts.yml`, shell history files (IronClaw `sensitive_paths.rs`).
No false positives on ordinary text: tests with realistic prose, code and hashes that must pass untouched.
