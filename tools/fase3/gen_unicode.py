#!/usr/bin/env python3
# Fase 3: gera app/native/bg_unicode.h, as tabelas de texto do nucleo do catalogo em C (bg_catalog.c):
#   - minusculas: o String.prototype.toLowerCase do QuickJS-ng 0.15 (o motor do ps5-react), tirado do proprio qjs
#     (cada code point; o sigma final e o unico caso que depende do contexto e fica no C);
#   - NFC/NFD: decomposicao canonica de um nivel, classe combinante (ccc) e os pares que compoem, do unicodedata do
#     Python (Unicode 15). O teste tests/catalog-text.test.mjs confere o C contra o normalize() do qjs.
# Uso (WSL): python3 tools/fase3/gen_unicode.py [qjs]   (padrao /root/forks/qjs-peak/build/qjs)
import os, subprocess, sys, tempfile, unicodedata

QJS = sys.argv[1] if len(sys.argv) > 1 else '/root/forks/qjs-peak/build/qjs'
repo = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
out_path = os.path.join(repo, 'app', 'native', 'bg_unicode.h')

script = r'''
const out = [];
for (let cp = 0; cp <= 0x10ffff; cp++) {
  if (cp >= 0xd800 && cp <= 0xdfff) continue;
  const s = String.fromCodePoint(cp), l = s.toLowerCase();
  if (l !== s) out.push(cp + ':' + [...l].map((c) => c.codePointAt(0)).join(','));
}
print(out.join(' '));
'''
with tempfile.NamedTemporaryFile('w', suffix='.js', delete=False) as f:
    f.write(script)
    js = f.name
lower_text = subprocess.run([QJS, js], capture_output=True, text=True, check=True).stdout.split()
os.unlink(js)
lower = []
for item in lower_text:
    cp, to = item.split(':')
    to = [int(x) for x in to.split(',')]
    if len(to) != 1:
        if int(cp) != 0x130: raise SystemExit(f'minuscula com mais de um code point: {cp} -> {to}')
        continue  # U+0130 -> "i" + U+0307, no C
    lower.append((int(cp), to[0]))
# Faixas: (inicio, fim, delta, passo) com passo 1 (todos) ou 2 (alternados).
ranges = []
for cp, to in lower:
    d = to - cp
    if ranges:
        s, e, dd, step = ranges[-1]
        if dd == d and step in (0, 1) and cp == e + 1:
            ranges[-1] = (s, cp, d, 1); continue
        if dd == d and step in (0, 2) and cp == e + 2:
            ranges[-1] = (s, cp, d, 2); continue
    ranges.append((cp, cp, d, 0))

decomp, ccc, comp = [], [], []
for cp in range(0x110000):
    if 0xd800 <= cp <= 0xdfff or 0xac00 <= cp <= 0xd7a3: continue
    ch = chr(cp)
    c = unicodedata.combining(ch)
    if c: ccc.append((cp, c))
    d = unicodedata.decomposition(ch)
    if not d or d.startswith('<'): continue
    parts = [int(x, 16) for x in d.split()]
    if len(parts) > 2: raise SystemExit(f'decomposicao com {len(parts)} partes: {cp:x}')
    decomp.append((cp, parts[0], parts[1] if len(parts) == 2 else 0))
    if len(parts) == 2 and unicodedata.normalize('NFC', chr(parts[0]) + chr(parts[1])) == ch:
        comp.append(((parts[0] << 21) | parts[1], cp))
comp.sort()
ccc_ranges = []
for cp, c in ccc:
    if ccc_ranges and ccc_ranges[-1][2] == c and ccc_ranges[-1][1] == cp - 1:
        ccc_ranges[-1] = (ccc_ranges[-1][0], cp, c)
    else:
        ccc_ranges.append((cp, cp, c))

def rows(items, fmt, per=6):
    lines = []
    for i in range(0, len(items), per):
        lines.append('  ' + ' '.join(fmt(x) for x in items[i:i + per]))
    return '\n'.join(lines)

with open(out_path, 'w', newline='\n') as f:
    f.write(f'''// GERADO por tools/fase3/gen_unicode.py: nao editar. Minusculas do QuickJS-ng 0.15 (toLowerCase), NFC/NFD do Unicode
// {unicodedata.unidata_version} (decomposicao canonica de um nivel, ccc, pares que compoem). Usado por bg_catalog.c.
#define UNI_LOWER_COUNT {len(ranges)}
static const struct {{ uint32_t from, to; int32_t delta; uint8_t step; }} UNI_LOWER[UNI_LOWER_COUNT] = {{
{rows(ranges, lambda r: f'{{0x{r[0]:x},0x{r[1]:x},{r[2]},{r[3]}}},', 4)}
}};
#define UNI_DECOMP_COUNT {len(decomp)}
static const uint32_t UNI_DECOMP[UNI_DECOMP_COUNT][3] = {{
{rows(decomp, lambda r: f'{{0x{r[0]:x},0x{r[1]:x},0x{r[2]:x}}},', 5)}
}};
#define UNI_CCC_COUNT {len(ccc_ranges)}
static const struct {{ uint32_t from, to; uint8_t ccc; }} UNI_CCC[UNI_CCC_COUNT] = {{
{rows(ccc_ranges, lambda r: f'{{0x{r[0]:x},0x{r[1]:x},{r[2]}}},', 5)}
}};
#define UNI_COMP_COUNT {len(comp)}
static const struct {{ uint64_t pair; uint32_t cp; }} UNI_COMP[UNI_COMP_COUNT] = {{
{rows(comp, lambda r: f'{{0x{r[0]:x}ull,0x{r[1]:x}}},', 4)}
}};
''')
print(f'{out_path}: lower {len(ranges)} faixas, decomp {len(decomp)}, ccc {len(ccc_ranges)} faixas, comp {len(comp)}')
