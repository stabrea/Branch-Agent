import re,sys
p="src/server.ts"; s=open(p,encoding="utf-8").read()
def grp(t):
    m=re.search(r"api\/\(([^)]*)\)\(", t); return m.group(1).split("|") if m else None
def lits(t):
    m=re.search(r'\[("[^\]]*")\]\.includes', t); return [x.strip().strip('"') for x in m.group(1).split(",")] if m else None
ms=list(re.finditer(r"<<<<<<< HEAD\n(.*?)(?:\|\|\|\|\|\|\| [0-9a-f]+\n.*?)?=======\n(.*?)>>>>>>> [^\n]+\n", s, flags=re.S))
for m in reversed(ms):
    h,o=m.group(1),m.group(2)
    if "includes(path)" in h and grp(h) and grp(o):
        g=grp(h)+[x for x in grp(o) if x not in grp(h)]
        l=(lits(h) or [])+[x for x in (lits(o) or []) if x not in (lits(h) or [])]
        new=re.sub(r"api\/\(([^)]*)\)\(", lambda mm: "api\/("+"|".join(g)+")(", h, count=1)
        new=re.sub(r'\[("[^\]]*")\]\.includes', "["+", ".join('"%s"'%x for x in l)+"].includes", new, count=1)
        # extra trailing alternatives (lines) from other side not in head
        for line in o.split("\n"):
            if line.strip().startswith("||") and line not in new: new=new.rstrip("\n")+"\n"+line+"\n"
        s=s[:m.start()]+new+s[m.end():]; print("union:", "|".join(g)); 
    else:
        s=s[:m.start()]+h+o+s[m.end():]; print("kept both")
open(p,"w",encoding="utf-8").write(s)
