# mac2/bottom-buckets: buckets 23, 22 and 21 of the public list, bottom up

Area `bottom-buckets`. Read `docs/agents/briefs/mac2/README.md`.
The rows (ids) are in `gh issue view 103 -R stabrea/Branch-Agent` under buckets 21, 22 and 23; their original
wording is in `docs/audit/todo.md` and the theme issues. **Many row notes are stale** (for example A1932 browser
extension and A0464 desktop sessions already exist). For every row decide, in this order of preference:
VERIFY (it is already true: name the source file and a test that asserts the behaviour; add the test if missing) /
BUILD (small, owner-meaningful, no new dependency) / DOCUMENT (why not, or which existing feature covers it) /
NOT APPLICABLE (with the reason).

Guidance: bucket 23 rows A0794 project bookkeeping, A2334 artifact versioning, A1012/A2258/A0032/A0601 runtimes and
app-server (Branch already has an OpenAI-compatible API, ACP, MCP server and CLI-agent backends — verify, then
document), A0504/A1620 consent-gated analytics (Branch sends nothing: document the stance, no telemetry built),
A2367 PaLM (not applicable: retired), A1895 image generation (verify against the media work).
Bucket 21: a small Python client package under `packages/sdk-python/` (standard library only: urllib, json) that
covers start task, stream events, read result, approvals, memory search, matching the TypeScript SDK in
`packages/sdk/`; tests with Python `unittest` against a fake local server; A2353/A0758 verify the REST API and the
OpenAPI document. Bucket 22: verify what wave mac1 built (installers, packaging per platform, `package.yml`) and
document the remaining signed-installer steps. You own new files, `packages/sdk-python/**`, and the tests you add;
touch shared files only minimally.

Report: one line per row id (verdict + file + test, or the reason).
