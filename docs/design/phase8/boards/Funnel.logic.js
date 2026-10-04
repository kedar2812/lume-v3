class DCLogic{constructor(p){this.props=p;this.state={}}setState(x){Object.assign(this.state,typeof x==="function"?x(this.state):x)}}

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

// ── Phase 8 analytics: shared logic (each board carries its own copy) ──
// A seeded random, so every board draws the same made-up business every time.
function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
const inr = (n) => '₹' + Math.round(n).toLocaleString('en-IN');
// ₹12.4L, ₹1.2Cr: how money reads at a glance in India.
function inrShort(n) {
  const a = Math.abs(n);
  if (a >= 1e7) return '₹' + (n / 1e7).toFixed(a >= 1e8 ? 0 : 1).replace(/\.0$/, '') + 'Cr';
  if (a >= 1e5) return '₹' + (n / 1e5).toFixed(a >= 1e6 ? 0 : 1).replace(/\.0$/, '') + 'L';
  if (a >= 1e3) return '₹' + (n / 1e3).toFixed(a >= 1e4 ? 0 : 1).replace(/\.0$/, '') + 'k';
  return '₹' + Math.round(n);
}
const pctS = (v, d = 0) => (v * 100).toFixed(d) + '%';
const MINUS = '−';

/**
 * The owner's trend rule (2026-09-29), exactly:
 * - one rule for every change: trend(now, before, { kind: pct | pts | abs, good: up | down });
 * - the arrow follows the direction, the colour follows good or bad (fewer lost = green, pointing down);
 * - decided on the rounded number shown: never "+0.0%"; zero is grey "No change" with a flat line;
 * - the number always carries + or − (U+2212); colour is never the only signal;
 * - a "before" of 0 gives "New", not an infinite %.
 */
function trend(now, before, o = {}) {
  const kind = o.kind || 'pct', good = o.good || 'up', digits = o.digits ?? (kind === 'pct' ? 0 : kind === 'pts' ? 1 : 0);
  if (kind === 'pct' && before === 0) return now === 0 ? { text: 'No change', dir: 'flat', tone: 'flat' } : { text: 'New', dir: 'up', tone: good === 'up' ? 'good' : 'bad' };
  let raw = kind === 'pct' ? ((now - before) / Math.abs(before)) * 100 : kind === 'pts' ? (now - before) * 100 : now - before;
  const shown = Number(Math.abs(raw).toFixed(digits));
  if (shown === 0) return { text: 'No change', dir: 'flat', tone: 'flat' };
  const dir = raw > 0 ? 'up' : 'down';
  const sign = raw > 0 ? '+' : MINUS;
  const unit = kind === 'pct' ? '%' : kind === 'pts' ? ' pts' : (o.unit ? ' ' + o.unit : '');
  const body = o.money ? inrShort(shown) : shown.toLocaleString('en-IN', { minimumFractionDigits: digits, maximumFractionDigits: digits });
  return { text: sign + body + unit, dir, tone: (dir === 'up') === (good === 'up') ? 'good' : 'bad' };
}
// The jagged "trending" arrows, and the flat line for no change.
const TREND_SVG = {
  up: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1.5 11.5 6 7l3 3 5.5-5.5"/><path d="M10.5 4.5h4v4"/></svg>',
  down: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1.5 4.5 6 9l3-3 5.5 5.5"/><path d="M10.5 11.5h4v-4"/></svg>',
  flat: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M2 8h12"/></svg>',
};
const chipCls = (t) => 'tchip ' + t.tone;

// A smooth line through points (monotone: it never overshoots a dip or a peak).
function smooth(pts) {
  if (pts.length < 2) return '';
  const n = pts.length, dx = [], dy = [], m = [], t = [];
  for (let i = 0; i < n - 1; i++) { dx[i] = pts[i + 1][0] - pts[i][0]; dy[i] = pts[i + 1][1] - pts[i][1]; m[i] = dy[i] / dx[i]; }
  t[0] = m[0]; t[n - 1] = m[n - 2];
  for (let i = 1; i < n - 1; i++) t[i] = m[i - 1] * m[i] <= 0 ? 0 : (m[i - 1] + m[i]) / 2;
  let d = `M${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}`;
  for (let i = 0; i < n - 1; i++) {
    const h = dx[i] / 3;
    d += ` C${(pts[i][0] + h).toFixed(1)},${(pts[i][1] + t[i] * h).toFixed(1)} ${(pts[i + 1][0] - h).toFixed(1)},${(pts[i + 1][1] - t[i + 1] * h).toFixed(1)} ${pts[i + 1][0].toFixed(1)},${pts[i + 1][1].toFixed(1)}`;
  }
  return d;
}
// Values → points in a box; the same count every time, so a range change morphs instead of jumping.
function toPts(vals, w, h, max, pad = 4) {
  const n = vals.length;
  return vals.map((v, i) => [pad + (i * (w - pad * 2)) / (n - 1), h - pad - (v / (max || 1)) * (h - pad * 2)]);
}
const areaOf = (line, w, h) => `${line} L${w - 4},${h} L4,${h} Z`;
// Resample any series to n points (a range change keeps the path's shape count).
function resample(vals, n) {
  if (vals.length === n) return vals;
  return Array.from({ length: n }, (_, i) => { const x = (i * (vals.length - 1)) / (n - 1); const a = Math.floor(x), b = Math.min(vals.length - 1, a + 1); return vals[a] + (vals[b] - vals[a]) * (x - a); });
}
// A donut's slices as dash arrays on one circle (circumference c).
function donut(vals, r) {
  const c = 2 * Math.PI * r, total = vals.reduce((a, b) => a + b, 0) || 1;
  let at = 0;
  return vals.map((v) => { const len = (v / total) * c; const s = { dash: `${Math.max(0, len - 2).toFixed(2)} ${c.toFixed(2)}`, off: (-at).toFixed(2), share: v / total }; at += len; return s; });
}
function niceMax(v) { const p = Math.pow(10, Math.floor(Math.log10(v || 1))); return Math.ceil(v / p / 2) * p * 2; }
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

// The date range every analytics screen shares: presets, compare, and October 2026 drawn for the custom range.
const RANGES = [
  { id: 'today', label: 'Today', days: 1, words: 'Today', vs: 'vs yesterday' },
  { id: '7d', label: 'Last 7 days', days: 7, words: 'Last 7 days', vs: 'vs the 7 before' },
  { id: '30d', label: 'Last 30 days', days: 30, words: 'Last 30 days', vs: 'vs the 30 before' },
  { id: 'month', label: 'This month', days: 3, words: 'October 1 – 3', vs: 'vs September 1 – 3' },
  { id: 'lastmonth', label: 'Last month', days: 30, words: 'September', vs: 'vs August' },
  { id: 'quarter', label: 'This quarter', days: 95, words: 'July 1 – October 3', vs: 'vs the quarter before' },
  { id: '12m', label: 'Last 12 months', days: 365, words: 'Last 12 months', vs: 'vs the 12 before' },
];
function rangeVals(c) {
  const s = c.state;
  const r = RANGES.find((x) => x.id === (s.range || '30d'));
  const start = 3 - r.days + 1; // October 3, 2026 is "today"
  const cells = [];
  const firstDow = 3; // October 1, 2026 is a Thursday (Mon = 0)
  for (let i = 0; i < 35; i++) {
    const d = i - firstDow + 1;
    const out = d < 1 || d > 31;
    const inRange = !out && d >= start && d <= 3;
    cells.push({ d: out ? (d < 1 ? 30 + d : d - 31) : d, cls: 'dd' + (out ? ' out' : '') + (inRange ? (d === 3 || d === Math.max(1, start) ? ' end' : ' inr') : '') + (d === 3 && !out ? ' today' : '') });
  }
  const pick = (id) => () => { c.setState({ range: id, rangeOpen: false }); c.onRange && c.onRange(id); };
  return {
    rangeText: r.words, rangeVs: s.compare === false ? '' : r.vs, rpopCls: 'rpop' + (s.rangeOpen ? ' open' : ''),
    openRange: () => c.setState({ rangeOpen: !s.rangeOpen }),
    presets: RANGES.map((x) => ({ label: x.label, cls: x.id === r.id ? 'on' : '', pick: pick(x.id) })),
    calCells: cells, cmpCls: 'switch' + (s.compare === false ? '' : ' on'),
    toggleCompare: () => c.setState({ compare: s.compare === false }),
  };
}

// Any shown value as rolling slots: digits roll, other characters (₹ L % . min) sit still. Right-aligned in a fixed
// number of slots, so each column keeps its element and a change rolls instead of replacing.
function odoStr(str, slots = 9) {
  const s = String(str).padStart(slots, ' ').slice(-slots);
  return s.split('').map((ch) => {
    if (ch === ' ') return { cls: 'd x', y: 'transform:translateY(0)', ch: '' };
    if (/[0-9]/.test(ch)) return { cls: 'd', y: `transform:translateY(calc(-1.2em * ${ch}))`, ch: '' };
    return { cls: 'd ch', y: 'transform:translateY(0)', ch };
  });
}
// The area between two lines (a stacked band): the top forwards, the bottom back.
function band(top, bottom) {
  const rev = bottom.slice().reverse();
  return smooth(top) + ' L' + rev[0][0].toFixed(1) + ',' + rev[0][1].toFixed(1) + smooth(rev).replace(/^M[^C]*/, '') + ' Z';
}
const ST = ['New', 'Contacted', 'Replied', 'Call booked', 'Proposal', 'Won'];
const SHARE = [1, 0.86, 0.41, 0.18, 0.113, 0.061];
const SRC = [['Instagram', '#2a5bff', '#4d7bff', [0.46, 0.45, 0.44, 0.41, 0.4, 0.37]], ['Website', '#5ab8ff', '#7cc8ff', [0.32, 0.32, 0.31, 0.3, 0.29, 0.28]], ['Referrals', '#18a566', '#4fd69c', [0.13, 0.14, 0.15, 0.17, 0.18, 0.2]], ['Webinars', '#f2a20c', '#ffc75c', [0.09, 0.09, 0.1, 0.12, 0.13, 0.15]]];
const OWN = [['Riya Shah', '#0B7285', '#1395a8', [0.28, 0.29, 0.31, 0.33, 0.34, 0.36]], ['Dev Malhotra', '#A15C00', '#c98316', [0.26, 0.25, 0.23, 0.21, 0.2, 0.18]], ['Hana Ito', '#0F7F44', '#1fa864', [0.24, 0.25, 0.26, 0.27, 0.27, 0.28]], ['Leo Martins', '#B02E6B', '#d24a8a', [0.22, 0.21, 0.2, 0.19, 0.19, 0.18]]];
const X0 = 40, X1 = 720, CY = 140, MAXH = 190;
class Component extends DCLogic {
  constructor(p) { super(p); this.state = { themePick: 'auto', range: '30d', compare: true }; }
  renderVals() {
    const s = this.state;
    const g = s.group ?? this.props.groupBy ?? 'nothing';
    const R = RANGES.find((x) => x.id === s.range);
    const days = R.days;
    const cohort = Math.round(127 * days);
    const xs = ST.map((_, i) => X0 + (i * (X1 - X0)) / (ST.length - 1));
    const h = SHARE.map((v) => Math.max(8, v * MAXH));
    // the ribbon: centred, its height the share that got this far; split into layers when grouped
    const parts = g === 'source' ? SRC : g === 'owner' ? OWN : [['All leads', '#2a5bff', '#5ab8ff', SHARE.map(() => 1)]];
    let acc = SHARE.map(() => 0);
    const layers = parts.map((p, li) => {
      const top = h.map((hh, i) => CY - hh / 2 + acc[i] * hh);
      acc = acc.map((a, i) => a + p[3][i]);
      const bot = h.map((hh, i) => CY - hh / 2 + acc[i] * hh);
      const d = band(xs.map((x, i) => [x, top[i]]), xs.map((x, i) => [x, bot[i]]));
      return { gid: 'lg' + li, c1: p[1], c2: p[2], fill: `url(#lg${li})`, d: `d:path('${d}')`, drill: () => undefined };
    });
    // what leaves between two stages, falling away under the ribbon
    const streams = xs.slice(0, -1).map((x, i) => {
      const x2 = xs[i + 1], w = ((h[i] - h[i + 1]) / MAXH) * 40 + 4, y0 = CY + h[i + 1] / 2;
      const d = `M${x + 20},${y0} C${x + 50},${y0} ${x + 60},${y0 + 30} ${x + 70},250 L${x + 70 + w},250 C${x + 66 + w},${y0 + 24} ${x + 54 + w},${y0 - 2} ${x + 20 + w * 2},${y0 - 2} Z`;
      return { d: `d:path('${d}')`, x2 };
    });
    return {
      ...themeVals(this), ...rangeVals(this), filterN: '0',
      cohortN: fmt(cohort), rangeLower: R.words.toLowerCase().replace(/^last/, 'in the last'),
      gKnob: g === 'nothing' ? 'width:74px;transform:translateX(0)' : g === 'source' ? 'width:66px;transform:translateX(74px)' : 'width:62px;transform:translateX(140px)',
      gNone: g === 'nothing' ? 'on' : '', gSrc: g === 'source' ? 'on' : '', gOwn: g === 'owner' ? 'on' : '',
      gByNone: () => this.setState({ group: 'nothing' }), gBySrc: () => this.setState({ group: 'source' }), gByOwn: () => this.setState({ group: 'owner' }),
      layers, streams,
      layerLegend: parts.length > 1 ? parts.map((p) => ({ label: p[0], sw: `background:${p[1]}` })) : [{ label: 'Every lead that arrived', sw: 'background:#2a5bff' }],
      cols: ST.map((name, i) => ({ name, x: xs[i].toFixed(1), anchor: i === 0 ? 'start' : i === ST.length - 1 ? 'end' : 'middle', pct: pctS(SHARE[i], i === 5 ? 1 : 0), n: fmt(cohort * SHARE[i]) + ' leads' })).map((c, i) => ({ ...c, x: i === 0 ? '0' : i === ST.length - 1 ? '760' : c.x })),
      pills: xs.slice(0, -1).map((x, i) => ({ pos: `left:${(((x + xs[i + 1]) / 2) / 760) * 100}%;top:${(CY - 4) / 3}%`, v: pctS(SHARE[i + 1] / SHARE[i]) })),
      snap: [['New', 412, 0, '#8a94a6'], ['Contacted', 1386, 0, '#2a5bff'], ['Replied', 704, 0, '#5ab8ff'], ['Call booked', 296, 38000, '#5ab8ff'], ['Proposal', 141, 52000, '#f2a20c'], ['Won (this month)', 232, 41200, '#18a566']].map((r, i, a) => ({ i: `--i:${i}`, name: r[0], n: fmt(r[1]), bar: `width:${(r[1] / 1386) * 100}%;background:linear-gradient(90deg,${r[3]},${r[3]}cc)`, v: r[2] ? inrShort(r[1] * r[2]) : '—', avg: r[2] ? `avg ${inrShort(r[2])}` : 'no value yet' })),
      openValue: inrShort(296 * 38000 + 141 * 52000), openN: fmt(412 + 1386 + 704 + 296 + 141),
      tis: [['New', 0.4, 1.1, 1], ['Contacted', 1.6, 3.4, 3], ['Replied', 2.1, 4.8, 4], ['Call booked', 3.4, 6.2, 7], ['Proposal', 5.8, 12.4, 10]].map((t) => {
        const max = 14, over = t[2] > t[3];
        const fmtD = (d) => (d < 1 ? `${Math.round(d * 24)} h` : `${d.toFixed(1).replace(/\.0$/, '')} d`);
        return { cls: 'ti' + (over ? ' over' : ''), name: t[0], rng: `left:0;width:${(t[2] / max) * 100}%`, med: `left:calc(${(t[1] / max) * 100}% - 1.5px)`, sla: `left:${(t[3] / max) * 100}%`, medT: fmtD(t[1]), p75T: `P75 ${fmtD(t[2])}` };
      }),
      stuckN: '38', noop: () => undefined,
      vOpen: fmt(2939), vWin: '6.1%', vDeal: inrShort(41200), vCycle: '19', vOut: inrShort((2939 * 0.061 * 41200) / 19),
      vChip: 'tchip good', vDelta: '+9%',
      hist: [2, 5, 9, 14, 18, 21, 19, 16, 13, 10, 8, 6, 5, 3, 2, 1].map((v, i) => ({ cls: i === 5 ? 'm' : '', st: `height:${(v / 21) * 100}%;--i:${i}` })),
      fc: [['October', 2310000, [0.55, 0.3, 0.15]], ['November', 1680000, [0.35, 0.4, 0.25]], ['December', 940000, [0.2, 0.35, 0.45]], ['January', 410000, [0.1, 0.3, 0.6]]].map((f, i) => ({ i: `--i:${i}`, m: f[0], v: inrShort(f[1]), h: `height:${(f[1] / 2310000) * 100}%`, parts: f[2].map((p, j) => `flex:${p};background:${['#2a5bff', '#5ab8ff', 'rgba(42,91,255,.25)'][j]}`) })),
    };
  }
}

module.exports={Component};
