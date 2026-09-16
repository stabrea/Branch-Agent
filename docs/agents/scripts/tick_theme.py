"""Tick audit ids in the theme issues: python tick_theme.py <version> <issue>=<id,id,...> [<issue>=<ids>...]
Optional note per issue with '#': <issue>=<ids>#<comment text>."""
import subprocess, sys, re, tempfile, os
os.chdir("C:/Users/bishi/Documents/Codex/Branch-build")
version = sys.argv[1]

def gh(*args, body=None):
    if body is not None:
        with tempfile.NamedTemporaryFile("w", suffix=".md", delete=False, encoding="utf-8") as f: f.write(body); path = f.name
        args = (*args, "--body-file", path)
    r = subprocess.run(["gh", *args], capture_output=True, text=True, encoding="utf-8")
    if r.returncode: print("gh failed:", args[:3], r.stderr.strip()[:200])
    return r.stdout

for spec in sys.argv[2:]:
    issue, rest = spec.split("=", 1)
    ids_part, _, note = rest.partition("#")
    ids = [x for x in ids_part.split(",") if x]
    body = gh("issue", "view", issue, "--json", "body", "--jq", ".body")
    ticked = []
    for aid in ids:
        new, n = re.subn(r"- \[ \] `" + aid + r"`", f"- [x] `{aid}` ({version})", body)
        if n: body = new; ticked.append(aid)
    if ticked:
        gh("issue", "edit", issue, body=body)
    comment = f"Shipped in {version}: " + (", ".join(f"`{a}`" for a in ticked) if ticked else "no checklist ids") + (f". {note}" if note else "")
    gh("issue", "comment", issue, "--body", comment)
    print(f"issue {issue}: ticked {len(ticked)} of {len(ids)}")
