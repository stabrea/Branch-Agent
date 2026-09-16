# Wave 5 task: data work and deep research

Rules: docs/agents/briefs/wave1/BUILD.md. Branch: wave5/data-research from the local branch wave2/integration. Themes: data-and-analytics (#88), research-pipeline (#91), plus the "Packages" inventory items (#15: research, monitoring, morning brief). Backend tools; results render through the existing message column (tables as Markdown) and a Documents-panel style list for reports.

Read: src/documents.ts and src/document-text.ts (csv/xlsx reading), src/integrations/web.ts (search/fetch), src/integrations/browser.ts, src/scheduler*.ts, src/channels (delivery), src/recipes*.ts, docs/configuration.md.

Build:
1. Tabular data tools: `data.load { path | url }` for CSV/TSV/JSON/XLSX into an in-memory table (bounded rows), `data.describe`, `data.query { sql }` using node:sqlite in-memory (load the table, run read-only SQL, return rows), `data.chart { spec }` rendering a simple SVG (bar/line/pie) saved as an artifact, `data.export { path, format }` to CSV/XLSX (xlsx writer with node:zlib, minimal) in the workspace.
2. Research pipeline: `research.run { question, depth: quick|standard|deep, sources?: [urls] }` that plans sub-questions, searches and fetches under the network policy, extracts passages with citations (url, title, quote), cross-checks claims across at least two sources for "standard" and above, and writes a report to the workspace (`research/<slug>.md`) with a sources section; uses the documents library when the owner has relevant documents; budgeted and resumable; progress events for the context pane.
3. Monitoring package: `monitor.create { url | query, every, notifyVia }` on the scheduler that re-runs a fetch/search, diffs against the last snapshot, and delivers a plain-language change summary through a channel or the activity feed; `monitor.list/remove`.
4. Morning brief package: a recipe/schedule that assembles calendar-free content the app already has (today's schedules, unfinished tasks, new documents, monitors that changed, memory reminders) into one message at a chosen time, delivered to a chosen channel; templated, editable.
5. Citations everywhere: a shared `citations.ts` helper used by research and documents retrieval so answers carry `[1]` style references with a sources list the UI already renders as Markdown.

Tests (tests/data-research.test.mjs): load/query/chart/export round trips (xlsx written then read back by the existing reader); research run against local fake pages with two sources agreeing and one disagreeing, report file shape and citations; monitor detects a change and delivers via a fake channel; morning brief assembles and delivers; budget stops a deep run cleanly.

Acceptance: DR1 data tools proven; DR2 research report with citations proven; DR3 monitors proven; DR4 brief proven; DR5 docs sections; DR6 no new dependency. Report the ids you consider done and which inventory Packages items (#15) are covered.
