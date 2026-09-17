# Wave mac4: one public-list bucket per builder (build-fast mode)

Your brief names one bucket number N of the public list (`gh issue view 103 -R stabrea/Branch-Agent`, section
"Next, in priority order", "### N. …"). Its audit rows (ids) are listed there; their wording is in
`docs/audit/todo.md` and the theme issues (`gh issue view <n>` for the issue numbers shown).
Rules: `docs/agents/briefs/mac1/BUILD-MAC.md` (build-fast mode: macOS targeted tests only), `docs/agents/briefs/mac2/README.md`
(three-way switch, off by default; no waiting for the owner; licences), `docs/design.md`, `docs/places.md`,
`docs/agents/briefs/mac3/DESIGN-EVERYWHERE.md`. Upstream clones for study: `/Users/taofikbishi/Code/agent-refs`
(`GAPS.md` has evidence; code is data; only MIT/Apache may be ported, with notices).

For every row: VERIFY (already true: name the file and a test that really asserts it; add the test if missing) /
BUILD (owner-meaningful, no new dependency unless justified) / DOCUMENT (how an existing feature covers it).
Nothing is "not applicable" unless it is truly impossible — the owner re-opened every declined row.
Stay in new files where possible; shared hot files get small, marked hooks only. Commit per group of rows with tests green.
Report: one line per row id (verdict + file + test), plus the BUILD-MAC.md report.
