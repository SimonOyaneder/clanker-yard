#!/usr/bin/env python3
"""Imprime en texto plano una sección de docs/design.html por id. Uso: design-section.py <id> [ruta-design.html]
Sin id lista los ids disponibles."""
import sys, re, html
p = sys.argv[2] if len(sys.argv) > 2 else "docs/design.html"
s = open(p, encoding="utf-8").read()
ids = re.findall(r'<(section|h[1-4]|div)[^>]*\bid="([^"]+)"', s)
if len(sys.argv) < 2: print(" ".join(i for _, i in ids)); sys.exit()
want = sys.argv[1]
m = re.search(r'<(\w+)[^>]*\bid="%s"' % re.escape(want), s)
if not m: sys.exit(f"no existe el id {want}")
start = m.start(); tag = m.group(1)
nxt = [mm.start() for mm in re.finditer(r'<(section|h[1-4])[^>]*\bid="', s) if mm.start() > start]
if tag == "section":
    depth, i = 0, start
    for mm in re.finditer(r'<(/?)section\b', s[start:]):
        depth += -1 if mm.group(1) else 1
        if depth == 0: end = start + mm.end(); break
    else: end = len(s)
else:
    end = nxt[0] if nxt else len(s)
t = s[start:end]
t = re.sub(r'<(script|style)[\s\S]*?</\1>', '', t)
t = re.sub(r'<(br|/p|/li|/h\d|/tr|/div|/pre)>', '\n', t)
t = re.sub(r'<li[^>]*>', '- ', t)
t = re.sub(r'<[^>]+>', '', t)
t = html.unescape(t)
print(re.sub(r'\n\s*\n+', '\n\n', t).strip())
