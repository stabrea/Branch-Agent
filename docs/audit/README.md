# Capability audit of 120 open-source agents

Source: the owner's spreadsheet "Open Source AI Agent Capability Audit.xlsx" (120 projects, 2,792 rows, 2,406 distinct capability names).
Every row was classified against this codebase in two agent passes; the second pass re-checked every "missing" and
"partial" verdict with code searches and sorted the survivors into 38 themes.

- `audit-assessment.json`: every row with status, note, evidence paths, search terms, theme, family and the first-pass verdict.
- `todo.md`: the to-build list grouped by theme, families first.
- GitHub: one "Audit theme: …" issue per theme with a checklist; issue #42 is the index.

Result: 766 already in Branch, 389 partly, 744 missing and worth building, 501 not applicable to a local Windows desktop
assistant, 6 duplicates. To build: 786 distinct pieces of work (1,133 rows once families such as "add a provider
adapter" are counted once).
