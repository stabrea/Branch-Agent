import re, os, sys
os.chdir("C:/Users/bishi/Documents/Codex/Branch-build")
pat = re.compile(r"<<<<<<< HEAD\n(.*?)\|\|\|\|\|\|\| [0-9a-f]+\n(.*?)=======\n(.*?)>>>>>>> [^\n]+\n", re.S)
listpat = re.compile(r'\[("[^\]]*")\]')

def resolve(m):
    head, base, other = m.group(1), m.group(2), m.group(3)
    # A list literal of strings changed on both sides: take the union in order.
    hl, ol, bl = listpat.search(head), listpat.search(other), listpat.search(base)
    if hl and ol and head.count("\n") == 1 and other.count("\n") == 1:
        items = re.findall(r'"([^"]+)"', hl.group(1))
        for x in re.findall(r'"([^"]+)"', ol.group(1)):
            if x not in items: items.append(x)
        return head[:hl.start(1)] + ", ".join(f'"{x}"' for x in items) + head[hl.end(1):]
    # Otherwise keep HEAD and add only the lines from the other side that HEAD does not already have.
    head_lines = head.splitlines(keepends=True)
    extra = [l for l in other.splitlines(keepends=True) if l not in head_lines]
    return head + "".join(extra)

files = sys.argv[1:]
for p in files:
    s = open(p, encoding="utf-8").read()
    s2 = pat.sub(resolve, s)
    open(p, "w", encoding="utf-8").write(s2)
    print(p, "markers left:", s2.count("<<<<<<<"))
