#!/usr/bin/env python3
"""Build the static site: python3 site/build.py  ->  site/dist/  (serve with: python3 -m http.server -d site/dist 8080)

Templates live in site/src, static assets in site/public, generated tables come from site/data/*.json.
Refresh the data from the client repo with site/tools/refresh-data.sh (commands, models, next steps)."""
import datetime, html, json, os, shutil

ROOT = os.path.dirname(os.path.abspath(__file__)); SRC = f'{ROOT}/src'; OUT = f'{ROOT}/dist'
rd = lambda p: open(p, encoding='utf8').read()
load = lambda n: json.load(open(f'{ROOT}/data/{n}.json'))
esc = html.escape

commands = ''.join(f'<tr><td><code>/{esc(c["name"])}{" " + esc(c["args"]) if c.get("args") else ""}</code></td><td>{esc(c["desc"])}</td></tr>' for c in load('commands'))
models = ''.join(f'<tr><td>{esc(m["label"])}</td><td>{("<code>" + esc(m["id"]) + "</code>") if m["id"] else "<em>your CLI default</em>"}</td><td>{esc(m["note"])}</td></tr>' for m in load('models'))
st = load('status')
def clean(t): return esc(t).replace('`', '')
next_steps = ''.join(f'<li><strong>{clean(n["title"])}.</strong> {clean(n.get("why", ""))}</li>' for n in st['next'])
ctx = {'commands': commands, 'models': models, 'next_steps': next_steps, 'updated': st['updated'], 'year': str(datetime.date.today().year)}

def page(name, cur):
    t = rd(f'{SRC}/{name}')
    nav = rd(f'{SRC}/_nav.html').replace('{{cur_features}}', 'aria-current="page"' if cur == 'features' else '').replace('{{cur_docs}}', 'aria-current="page"' if cur == 'docs' else '')
    t = t.replace('{{nav}}', nav).replace('{{footer}}', rd(f'{SRC}/_footer.html'))
    for k, v in ctx.items(): t = t.replace('{{' + k + '}}', v)
    assert '{{' not in t, 'unreplaced placeholder in ' + name
    return t

shutil.rmtree(OUT, ignore_errors=True); shutil.copytree(f'{ROOT}/public', OUT)
open(f'{OUT}/index.html', 'w', encoding='utf8').write(page('index.html', 'features'))
os.makedirs(f'{OUT}/docs', exist_ok=True); open(f'{OUT}/docs/index.html', 'w', encoding='utf8').write(page('docs.html', 'docs'))
open(f'{OUT}/404.html', 'w', encoding='utf8').write(page('index.html', 'features').replace('<h1>Command <em>many hands.</em></h1>', '<h1>Lost at <em>sea.</em></h1>').replace('Early development · built by Caffeine Driven', '404 · page not found'))
print('built', OUT, sum(len(f) for _, _, f in os.walk(OUT)), 'files')
