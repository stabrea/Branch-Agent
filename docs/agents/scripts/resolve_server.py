import re, os
os.chdir("C:/Users/bishi/Documents/Codex/Branch-build")
pat = re.compile(r"<<<<<<< HEAD\n(.*?)\|\|\|\|\|\|\| [0-9a-f]+\n(.*?)=======\n(.*?)>>>>>>> [^\n]+\n", re.S)
group = re.compile(r"api\\/\(([^)]*)\)")

def resolve(m):
    head, base, other = m.group(1), m.group(2), m.group(3)
    hm, om = group.search(head), group.search(other)
    if hm and om:
        hs, os_ = hm.group(1).split("|"), om.group(1).split("|")
        union = hs + [x for x in os_ if x not in hs]
        if group.sub("G", head) != group.sub("G", other):
            print("NOTE: line differs beyond the group\n H:", group.sub("G", head)[:220], "\n O:", group.sub("G", other)[:220])
        return group.sub(lambda _: "api\\/(" + "|".join(union) + ")", head)
    return head + other

p = "src/server.ts"
s = open(p, encoding="utf-8").read()
s2 = pat.sub(resolve, s)
open(p, "w", encoding="utf-8").write(s2)
print(p, "markers left:", s2.count("<<<<<<<"))
for line in s2.splitlines():
    if "api\\/(sessions" in line:
        print(line.strip()[:240])
