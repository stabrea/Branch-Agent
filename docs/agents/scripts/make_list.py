import json, sys, re
from pathlib import Path
from collections import defaultdict
sys.path.insert(0, "C:/Users/bishi/AppData/Local/Temp/claude-session-files")
from buckets import BUCKETS, NOT_APPLICABLE

S = Path("C:/Users/bishi/AppData/Local/Temp/claude-session-files")
rows = json.loads((S / "all-rows.json").read_text(encoding="utf-8"))
info = {f"{r['issue']}:{r['id']}": r for r in rows}

PLAIN = {
 "agent-orchestration": "Specialists, sub-tasks, supervisors, swarms and handoff",
 "dashboards-and-observability": "Runs, usage, health and the details pane",
 "evaluation-and-benchmarks": "Scorers, studies, release gates and benchmark adapters",
 "tracing-and-telemetry": "Traces and spans you can export, and the metrics page",
 "permissions-and-policies": "Approval rules, grants, lockdown and household roles",
 "documents-and-rag": "Reading Word, Excel, PowerPoint, PDF and EPUB, with citations",
 "mcp-server-mode": "Speaking the tool protocol, both as a client and as a server",
 "cli-and-tui": "The command line and the terminal view",
 "secrets-and-auth": "The locker, short-lived keys and your own password manager",
 "browser-automation": "Driving a browser, and borrowing your signed-in one",
 "other": "The long tail: lockdown, kept answers, project defaults, thread tree, folder watch",
 "voice-io": "Speaking, listening, and live conversations you can interrupt",
 "vector-and-hybrid-memory": "Meaning-based search over your own material",
 "web-ui": "The window itself: chat, artifacts, charts, reports, to-dos, flow editor",
 "memory-features": "What it remembers, in layers, with a tidy pass that only suggests",
 "plugin-and-extension-system": "Plugins and skills with fingerprints and an explicit switch",
 "deployment-and-packaging": "Packaging, the silent updater and the diagnostics bundle",
 "skills-and-recipes": "Skills, saved procedures and their trial runs",
 "media-generation": "Making and editing pictures, reading sound, describing video",
 "models.cloud-providers": "Connecting to model services, and choosing between them",
 "context-management": "What goes into each round, and compaction when it gets long",
 "messaging-channels": "Reaching Branch from chat apps, with pairing and allowlists",
 "agent-interop": "Working with other agents over open protocols",
 "file-and-code-tools": "Files, patches, change sets and code checks",
 "webhooks-and-triggers": "Things that start a task on their own, signed and replay-proof",
 "desktop-automation": "Using the screen and keyboard, with a Stop button always on top",
 "git-integration": "Branches, worktrees, commits and sending work up",
 "data-and-analytics": "Tables you can query, and figures worked out on this computer",
 "sandboxing-and-isolation": "Holding a program to limits, and choosing how tightly per rule",
 "scheduling-and-automation": "Schedules, the waiting line and quiet hours",
 "models.local-runtimes": "Models running on this computer, found and started for you",
 "app-integrations": "GitHub, GitLab and the services you already use",
 "codebase-search": "Finding the right file in an unfamiliar project",
 "multi-user-and-teams": "More than one profile on one computer",
 "research-pipeline": "Deep research that cites what it read",
 "mobile-and-remote-access": "Reaching Branch from your phone over your own network",
 "ide-and-editor": "Editor-shaped surfaces",
 "models.routing-and-cost": "Falling back to another connection, and what each costs",
}

def versions_for(theme):
    vs = set()
    for r in rows:
        if r["done"] and r["theme"] == theme:
            v = (r["version"] or "").strip()
            m = re.match(r"^(\d+\.\d+\.\d+)$", v)
            if m: vs.add(m.group(1))
            elif v.startswith("merged"): vs.add("0.17.0*")
    def key(x): return [int(p) for p in x.replace("*", "").split(".")]
    return sorted(vs, key=key)

done_by = defaultdict(int)
for r in rows:
    if r["done"]: done_by[r["theme"]] += 1

out = []
w = out.append
w("# What Branch Agent has, what is being built, and what is next")
w("")
w("This is the single list. It is kept up to date as work happens, not at the end, so anyone can see")
w("where things stand right now. It is ordered by how much difference a thing makes to using Branch,")
w("**not** by how quick it is to build, and it is worked from the top down.")
w("")
w("The 38 theme issues (#55-#92, index #42) hold the same work as individual rows with audit ids.")
w("This page groups those rows so that one line is one job. Several audit rows often describe the same")
w("missing thing under different names; they are in one bucket here so that two people cannot pick up")
w("the same work by two different names.")
w("")
w("**How to read it**")
w("")
w("| What you see | What it means |")
w("| --- | --- |")
w("| A ticked box under **Already built** | Done and in a release you can download. |")
w("| A ticked box under **Done, not yet released** | Written, reviewed and merged. The code and its test exist; the release has not happened yet. Do not rebuild it. |")
w("| **Being built right now** | Someone is mid-branch on it. The branch name is given. |")
w("| An empty box under **Next** | Free. Take it. |")
w("")
w("**Before you start anything longer than an afternoon**, leave a one-line comment on this issue")
w("saying which bucket you are taking. That is the only thing that stops the same work being done")
w("twice. A box is ticked only when a reviewer has named the source file and a test that asserts the")
w("behaviour; a tool that exists but does nothing does not count. See")
w("[CONTRIBUTING.md](../blob/main/CONTRIBUTING.md).")
w("")
w("---")
w("")
w("## Already built and released")
w("")
w("Releases 0.2.0 through 0.16.0. Every item has a source file and a test that asserts it. A few")
w("groups also contain items that are finished but not released yet; those are listed separately below.")
w("")
order = sorted(done_by.items(), key=lambda x: -x[1])
shipped_total = 0
for theme, n in order:
    name = PLAIN.get(theme, theme)
    vs = versions_for(theme)
    star = "*" in "".join(vs)
    vs = [v.replace("*", "") for v in vs]
    span = "earlier releases" if not vs else (vs[0] if len(vs) < 2 else f"{vs[0]}-{vs[-1]}")
    w(f"- [x] **{name}** — {n} items, {span}." + (" Some ship in 0.17.0." if star else ""))
    shipped_total += n
w("")
w(f"**{shipped_total - 48} items released, plus the 48 below that are done but not yet released.**")
w("")
w("---")
w("")
w("## Done, reviewed and merged, not yet released (ships in 0.17.0)")
w("")
w("These are finished. They are ticked here rather than at release so that nobody rebuilds them.")
w("")
for name, ids, issue in [
 ("The command line as a real tool: every command documented, packed as an npm package, two clients on one conversation, exit codes scripts can rely on, installed coding-agent CLIs usable as model backends", "A0284 A0012 A0137 A0306 A0383 A0425 A0488 A0551 A0723 A0793 A0910 A1159 A1191 A2103 A2404", 72),
 ("Traces and logs that can leave on your terms: OTLP spans and log records, three destinations, the network policy checked before every single send", "A1149 A0056 A0799 A0800 A0856 A1287 A1440 A1497 A1498 A1523 A1583", 63),
 ("Artifacts, charts, reports, to-dos and the flow editor in the window itself", "A0584 A0593 A0635 A0647 A0656 A0752 A0777 A1209 A1441 A1454 A1490 A1730", 58),
 ("Short-lived keys that expire and can be revoked, secrets fetched from a command instead of copied, and a profile switch that is written down", "A0100 A0221 A0614 A1930 A2177", 69),
 ("Sealed artifact pages, an Obsidian folder bridge, a page widget and a browser extension", "A0275 A1940 A1983 A1997 A2093", 64),
]:
    w(f"- [x] **{name}** (#{issue}) — `" + "`, `".join(ids.split()) + "`")
w("")
w("**48 items.**")
w("")
w("---")
w("")
w("## Being built right now")
w("")
w("- [ ] **Real sandboxes and SSH workspaces** — branch `wave8/sandbox-remote`, about 3,600 lines in. Covers bucket 1 below.")
w("- [ ] **Writing Office documents, pictures as documents, knowledge graph** — branch `wave8/docs-3`, about 2,900 lines in. Covers bucket 2 below.")
w("")
w("---")
w("")
w("## Next, in priority order")
w("")
w("Worked from the top down. Each bucket is one job. The ids in brackets are the audit rows it closes,")
w("so you can find the original wording in the theme issue.")
w("")
for i, (t, why, keys) in enumerate(BUCKETS, 1):
    issues = sorted({int(k.split(":")[0]) for k in keys})
    ids = []
    for k in keys:
        rid = k.split(":", 1)[1]
        ids.append(rid.replace("FAMILY:", "family: ") if rid.startswith("FAMILY") else rid)
    w(f"### {i}. {t}")
    w("")
    w(why)
    w("")
    w(f"- [ ] **{len(keys)} rows** in " + ", ".join(f"#{n}" for n in issues))
    w("  <details><summary>which rows</summary>")
    w("")
    w("  " + ", ".join(f"`{x}`" for x in ids))
    w("  </details>")
    w("")
w("---")
w("")
w("## Not going to be built, and why")
w("")
w("These are real rows from the audit. They are listed so nobody spends a weekend on something that")
w("was decided against, and so the count of what is left stays honest.")
w("")
for t, why, keys in NOT_APPLICABLE:
    ids = [k.split(":", 1)[1] for k in keys]
    w(f"- **{t}** — {why}")
    w(f"  <details><summary>{len(keys)} rows</summary>")
    w("")
    w("  " + ", ".join(f"`{x}`" for x in ids))
    w("  </details>")
w("")
remaining = sum(len(k) for _, _, k in BUCKETS)
na = sum(len(k) for _, _, k in NOT_APPLICABLE)
w("---")
w("")
w("## The numbers, honestly")
w("")
w(f"- Built and released: **{shipped_total - 48}**")
w("- Done and merged, ships in 0.17.0: **48**")
w(f"- Left to build: **{remaining}** rows, grouped into **{len(BUCKETS)}** jobs")
w(f"- Decided against: **{na}** rows")
w("")
w("The row count overstates the work. Two verification passes over this list found that a large share")
w("of finished items were satisfied by one shared implementation rather than separate builds, and the")
w("buckets above show the same thing: 25 rows all asking for one workflow engine, and 22 asking for a")
w("web interface that already exists. Twenty-three jobs is the honest shape of what is")
w("left.")
w("")
w("Those two verification passes also re-opened 72 items that had been ticked without a test that")
w("asserted the behaviour. That is why the rule now is a named file and a named test, every time.")

text = "\n".join(out)
Path(S / "master-list.md").write_text(text, encoding="utf-8")
print("characters:", len(text), "(GitHub limit 65536)")
print("buckets:", len(BUCKETS), "| shipped:", shipped_total, "| remaining rows:", remaining, "| n/a:", na)
