"""Pulls the prototype's icon set (the `P` object and every later addition to it) into public/app/core/icons.js."""
import json
import re

src = open('design/redesign/prototype.html', encoding='utf8').read()
icons = {}
for m in re.finditer(r"(?:const P = \{|Object\.assign\(P, \{)", src):
    i = m.end()
    depth, j = 1, i
    while depth:
        c = src[j]
        if c in "'\"`":
            q = c
            j += 1
            while src[j] != q:
                if src[j] == '\\':
                    j += 1
                j += 1
        elif c == '{':
            depth += 1
        elif c == '}':
            depth -= 1
        j += 1
    for k, v in re.findall(r"['\"]?([A-Za-z0-9_]+)['\"]?\s*:\s*'((?:[^'\\]|\\.)*)'", src[i:j - 1]):
        icons[k] = v
if 'bell' not in icons:
    icons['bell'] = icons.get('bell16', '<path d="M6.5 16.5V11a5.5 5.5 0 0 1 11 0v5.5l1.5 1.5H5z"/><path d="M10 20.5h4"/>')
if 'mail' not in icons:
    icons['mail'] = '<rect x="3.5" y="5.5" width="17" height="13" rx="2"/><path d="M4 7l8 6 8-6"/>'
out = ("/* The icon set: stroke icons on a 24×24 grid (design doc 2). One source for the whole window. */\n"
       "export const ICONS = " + json.dumps(icons, indent=0, ensure_ascii=False) + ";\n")
open('public/app/core/icons.js', 'w', encoding='utf8').write(out)
print(len(icons), 'icons')
