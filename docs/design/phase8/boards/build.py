"""Builds the Phase 7 artboards: the shared head and chrome, plus each board's own CSS, body and logic."""
import json, os, re, sys

HERE = os.path.dirname(os.path.abspath(__file__))
LOGO = os.environ.get('LOGO', 'LOGO')
OUT = os.path.join(HERE, '..', 'project')
head = open(os.path.join(HERE, '..', 'shared-head.html'), encoding='utf-8').read()
common_css = open(os.path.join(HERE, 'common.css'), encoding='utf-8').read() + open(os.path.join(HERE, 'analytics.css'), encoding='utf-8').read()
charts_js = open(os.path.join(HERE, 'charts.js'), encoding='utf-8').read()

ICON = {
  'today': '<circle cx="12" cy="12" r="4"></circle><path d="M12 2v2M12 20v2m-7.07-17.07 1.41 1.41m11.32 11.32 1.41 1.41M2 12h2m16 0h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"></path>',
  'leads': '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"></path><path d="M16 3.128a4 4 0 0 1 0 7.744"></path><path d="M22 21v-2a4 4 0 0 0-3-3.87"></path><circle cx="9" cy="7" r="4"></circle>',
  'pipeline': '<rect width="18" height="18" x="3" y="3" rx="2"></rect><path d="M9 3v18"></path><path d="M15 3v18"></path>',
  'calendar': '<path d="M8 2v3"></path><path d="M16 2v3"></path><rect x="3" y="3" width="18" height="18" rx="2"></rect><path d="M3 9h18"></path>',
  'templates': '<path d="m22 7-8.991 5.727a2 2 0 0 1-2.009 0L2 7"></path><rect x="2" y="4" width="20" height="16" rx="2"></rect>',
  'analytics': '<path d="M3 3v16a2 2 0 0 0 2 2h16"></path><path d="M18 17V9"></path><path d="M13 17V5"></path><path d="M8 17v-3"></path>',
  'settings': '<circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path>',
}
NAV = [('today', 'Today', None), ('leads', 'Leads', None), ('pipeline', 'Pipeline', None),
       ('calendar', 'Calendar', None), ('templates', 'Templates', None), ('analytics', 'Analytics', 'Main.dc.html'),
       ('settings', 'Settings', None)]

def svg(name, extra=''):
  return f'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"{extra}>{ICON[name]}</svg>'

def sidebar(active, me):
  items = []
  for key, label, href in NAV:
    if key == active:
      items.append(f'<a class="navi on" href="{href or "#"}" aria-current="page">{svg(key)}<span>{label}</span></a>')
    elif href:
      items.append(f'<a class="navi" href="{href}">{svg(key)}<span>{label}</span></a>')
    else:
      items.append(f'<a class="navi off" href="#" title="Not part of this canvas" aria-disabled="true">{svg(key)}<span>{label}</span></a>')
  return ('<aside class="side"><div class="brand"><img src="/_blob/LOGO" alt="LUME"><div><b>LUME</b><span>Brightpath Studio</span></div></div>'
          + ''.join(items) + me + '</aside>')

ME_DEFAULT = '<div class="me"><div class="av" style="background:#2A5BFF">MK</div><div><div style="font-size:13px;font-weight:600">Maya Kapoor</div><div class="tiny">Owner</div></div></div>'

def topbar(crumb, slot, bell):
  return (f'<header class="top"><h1 class="h2" style="font-size:16px">{crumb}</h1>'
          '<button type="button" class="gsearch" aria-label="Search LUME"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" aria-hidden="true"><circle cx="7" cy="7" r="4.4"></circle><path d="m10.3 10.3 3.3 3.3"></path></svg><span>Search leads, actions…</span><span class="kbd">Ctrl K</span></button>'
          + slot +
          '<span class="seg tseg" role="radiogroup" aria-label="Theme"><span class="knob" style="{{tKnob}}"></span>'
          '<button type="button" class="{{tAuto}}" style="width:50px" onClick="{{pickAuto}}">Auto</button>'
          '<button type="button" class="{{tPor}}" style="width:84px" onClick="{{pickPor}}">Porcelain</button>'
          '<button type="button" class="{{tObs}}" style="width:80px" onClick="{{pickObs}}">Obsidian</button></span>'
          + bell + '</header>')

BELL_DEFAULT = '<button type="button" class="ibtn" aria-label="Notifications"><svg viewBox="0 0 16 16" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 11.5h9l-1-1.6V7a3.5 3.5 0 0 0-7 0v2.9z"></path><path d="M6.6 13.4a1.5 1.5 0 0 0 2.8 0"></path></svg></button>'

JS_COMMON = r"""
const fmt = (n) => Math.round(n).toLocaleString('en-US');
const THEMES = [['auto', 50], ['porcelain', 84], ['obsidian', 80]];
// The top bar's theme switch works here too: Auto follows the canvas's Look setting.
function themeVals(c) {
  const pick = c.state.themePick || 'auto';
  const theme = pick === 'auto' ? (c.props.theme ?? 'porcelain') : pick;
  let x = 0, w = 0;
  for (const [k, wd] of THEMES) { if (k === pick) { w = wd; break; } x += wd; }
  return {
    theme, tKnob: `width:${w}px;transform:translateX(${x}px)`,
    tAuto: pick === 'auto' ? 'on' : '', tPor: pick === 'porcelain' ? 'on' : '', tObs: pick === 'obsidian' ? 'on' : '',
    pickAuto: () => c.setState({ themePick: 'auto' }), pickPor: () => c.setState({ themePick: 'porcelain' }), pickObs: () => c.setState({ themePick: 'obsidian' }),
  };
}
// Six fixed slots, right-aligned: each column keeps its element, so a digit rolls instead of being replaced.
function odo(n) {
  return fmt(n).padStart(6, ' ').split('').map((ch) => {
    if (ch === ' ') return { cls: 'd x', y: 'transform:translateY(0)' };
    if (ch === ',') return { cls: 'd cm', y: 'transform:translateY(calc(-1.2em * 10))' };
    return { cls: 'd', y: `transform:translateY(calc(-1.2em * ${ch}))` };
  });
}
const ODO_STRIP = '';
"""
JS_COMMON += charts_js

ODO_CSS = """
.odo{display:inline-flex;font-variant-numeric:tabular-nums;line-height:1.2;height:1.2em;overflow:hidden;vertical-align:bottom}
.odo .d{display:inline-block;width:.62em;height:1.2em;overflow:hidden;text-align:center;transition:width .45s var(--spring),opacity .3s}
.odo .d.x{width:0;opacity:0}
.odo .d.cm{width:.3em}
.odo .s{display:flex;flex-direction:column;transition:transform var(--t) var(--spring)}
.odo .s span{height:1.2em;display:block}
.odo .d .c{display:none}
.odo .d.ch{width:auto}
.odo .d.ch .s{display:none}
.odo .d.ch .c{display:inline}
"""
ODO_HTML = '<span class="odo" aria-hidden="true"><sc-for list="{{LIST}}" as="d" hint-placeholder-count="6"><span class="{{d.cls}}"><span class="s" style="{{d.y}}"><span>0</span><span>1</span><span>2</span><span>3</span><span>4</span><span>5</span><span>6</span><span>7</span><span>8</span><span>9</span><span>,</span></span><span class="c">{{d.ch}}</span></span></sc-for></span>'

TABS = [('Overview', 'Main.dc.html', 86), ('Funnel', 'Funnel.dc.html', 72), ('Team', 'Team.dc.html', 62),
        ('Revenue & sources', 'Revenue.dc.html', 142), ('Lost', 'Lost.dc.html', 56), ('Timing & meetings', 'Timing.dc.html', 144),
        ('Templates & data', 'Quality.dc.html', 136)]

REP_TABS = [('My numbers', 'Rep.dc.html', 104), ('My funnel', None, 88), ('My timing', None, 90)]

def abar(active):
  x = 3
  tabs = []
  pill = ''
  rep = active.endswith('|rep')
  active = active.split('|')[0]
  for label, href, w in (REP_TABS if rep else TABS):
    if href is None:
      tabs.append(f'<a href="#" class="off" title="Not part of this canvas" style="width:{w}px;justify-content:center">{label}</a>')
      x += w + 2
      continue
    on = label == active
    if on: pill = f'<span class="pill" style="left:{x}px;width:{w}px"></span>'
    tabs.append(f'<a href="{href}" class="{"on" if on else ""}" style="width:{w}px;justify-content:center"{" aria-current=\"page\"" if on else ""}>{label}</a>')
    x += w + 2
  rng_btn = ('<div style="position:relative;margin-left:auto"><button type="button" class="rbtn" onClick="{{openRange}}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 2v3M16 2v3"/><rect x="3" y="4" width="18" height="17" rx="2"/><path d="M3 9h18"/></svg>{{rangeText}}<span class="vs">{{rangeVs}}</span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="width:12px;height:12px"><path d="m6 9 6 6 6-6"/></svg></button>'
             '<div class="{{rpopCls}}" role="dialog" aria-label="Date range"><div class="rpre"><sc-for list="{{presets}}" as="p" hint-placeholder-count="7"><button type="button" class="{{p.cls}}" onClick="{{p.pick}}">{{p.label}}</button></sc-for><button type="button">Custom…</button></div>'
             '<div class="rcal"><div class="mo"><span>October 2026</span><span class="cap">Times in Asia/Kolkata</span></div><div class="cal"><span class="dw">M</span><span class="dw">T</span><span class="dw">W</span><span class="dw">T</span><span class="dw">F</span><span class="dw">S</span><span class="dw">S</span><sc-for list="{{calCells}}" as="c" hint-placeholder-count="35"><span class="{{c.cls}}">{{c.d}}</span></sc-for></div>'
             '<div class="cmp"><div><b style="font-weight:600">Compare</b><span class="cap">with the period just before</span></div><button type="button" class="{{cmpCls}}" onClick="{{toggleCompare}}" aria-label="Compare with the period before"></button></div></div></div></div>')
  filt = '<button type="button" class="rbtn"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18M7 12h10M10 18h4"/></svg>Filters<span class="n">{{filterN}}</span></button>'
  exp = '<button type="button" class="ibtn tip" data-tip="Export these numbers (CSV)" aria-label="Export"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/></svg></button>'
  return f'<div class="abar"><nav class="mtabs" aria-label="Analytics">{pill}{"".join(tabs)}</nav>{rng_btn}{filt}{exp}</div>'

def section(text, name):
  m = re.search(r'^@@' + name + r'\b[^\n]*\n(.*?)(?=^@@[A-Z]+\b|\Z)', text, re.S | re.M)
  return m.group(1) if m else None

def build(name):
  src = open(os.path.join(HERE, name + '.src.html'), encoding='utf-8').read()
  meta = json.loads(section(src, 'META'))
  css = section(src, 'CSS') or ''
  body = section(src, 'BODY')
  script = section(src, 'SCRIPT')
  slot = section(src, 'SLOT') or ''
  bell = section(src, 'BELL') or BELL_DEFAULT
  me = section(src, 'ME') or ME_DEFAULT
  body = re.sub(r'\{\{ABAR:([^}]+)\}\}', lambda m: abar(m.group(1)), body)
  body = re.sub(r'\{\{ODO:([\w.]+)\}\}', lambda m: ODO_HTML.replace('LIST', m.group(1)), body)
  slot = re.sub(r'\{\{ODO:([\w.]+)\}\}', lambda m: ODO_HTML.replace('LIST', m.group(1)), slot)
  h = re.sub(r'<title>.*?</title>', f'<title>{meta["title"]}</title>', head)
  html = (h + common_css + ODO_CSS + css + '\n</style>\n</helmet>\n\n'
          + '<div class="lm" data-theme="{{theme}}" style="width:1440px;height:900px">\n<div class="shell">\n'
          + sidebar(meta.get('active', 'leads'), me) + '\n<main class="main"><div class="sheet">\n'
          + topbar(meta.get('crumb', 'Leads'), slot.strip(), bell.strip()) + '\n'
          + body + '\n</div></main>\n</div>\n</div>\n\n</x-dc>\n'
          + "<script type=\"text/x-dc\" data-dc-script data-props='" + json.dumps(meta['props'], ensure_ascii=False).replace("'", "&#39;") + "'>\n"
          + JS_COMMON + script + '\n</script>\n</body>\n</html>\n')
  html = html.replace('/_blob/LOGO', '/_blob/' + LOGO)
  open(os.path.join(OUT, name + '.dc.html'), 'w', encoding='utf-8').write(html)
  # the logic alone, for a Node check
  open(os.path.join(HERE, name + '.logic.js'), 'w', encoding='utf-8').write(
    'class DCLogic{constructor(p){this.props=p;this.state={}}setState(x){Object.assign(this.state,typeof x==="function"?x(this.state):x)}}\n'
    + JS_COMMON + script + '\nmodule.exports={Component};\n')
  print(name, len(html))

for n in sys.argv[1:]:
  build(n)
