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
const PKGS = [['Growth', '#2a5bff', 76, 2940000], ['Starter', '#5ab8ff', 112, 1680000], ['Premium', '#18a566', 21, 1890000], ['Add-ons', '#f2a20c', 23, 370000]];
const SOURCES = [
  ['Instagram ads', 'Paid · Meta', 'IG', '#2a5bff', 1784, 92, 2960000, 180000],
  ['Website form', 'Webhook', 'W', '#5ab8ff', 1236, 71, 2510000, 0],
  ['Referrals', 'Manual', 'R', '#18a566', 418, 41, 1990000, 0],
  ['Webinars', 'Google Sheet', 'Wb', '#f2a20c', 342, 32, 1460000, 45000],
  ['Google ads', 'Paid · Google', 'G', '#e35d8f', 296, 9, 290000, 120000],
  ['Calendly', 'Bookings', 'C', '#8a94a6', 128, 18, 690000, null],
];
const W = 700, H = 226;
class Component extends DCLogic {
  constructor(p) { super(p); this.state = { themePick: 'auto', range: '30d', compare: true, hot: null }; }
  renderVals() {
    const s = this.state;
    const R = RANGES.find((x) => x.id === s.range);
    const view = s.view ?? (this.props.view === 'by month' ? 'month' : 'goal');
    // this month: cumulative revenue day by day, against a straight line to the goal
    const daysIn = 31, today = 3;
    const cum = [];
    // October so far is 3 days; the chart shows the month to date and the pace to the end
    const sofar = [0, 190000, 420000, 640000];
    for (let i = 0; i <= today; i++) cum.push(sofar[i]);
    const goal = 6200000, perDay = sofar[today] / today;
    const max = niceMax(goal * 1.15);
    const xOf = (d) => 4 + (d / daysIn) * (W - 8);
    const yOf = (v) => H - 4 - (v / max) * (H - 12);
    const pts = cum.map((v, i) => [xOf(i), yOf(v)]);
    const line = smooth(pts);
    const projEnd = perDay * daysIn;
    // the 12 months, as bars
    const months = ['Nov', 'Dec', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct'];
    const mv = [3.1, 3.6, 2.9, 3.8, 4.2, 4.0, 4.9, 5.3, 5.1, 5.9, 6.6, 1.01].map((v) => v * 1e6);
    const mmax = niceMax(Math.max(...mv) * 1.1);
    const bw = (W - 20) / 12 - 14;
    const total = PKGS.reduce((a, p) => a + p[3], 0);
    const sl = donut(PKGS.map((p) => p[3]), 80);
    const hot = s.hot;
    return {
      ...themeVals(this), ...rangeVals(this), filterN: '0',
      rangeLower: R.words.toLowerCase().replace(/^last/, 'in the last'),
      vKnob: view === 'goal' ? 'width:96px;transform:translateX(0)' : 'width:84px;transform:translateX(96px)',
      vGoal: view === 'goal' ? 'on' : '', vMonth: view === 'month' ? 'on' : '',
      toGoal: () => this.setState({ view: 'goal' }), toMonth: () => this.setState({ view: 'month' }),
      goalView: view === 'goal', monthView: view === 'month',
      chartTitle: view === 'goal' ? 'October, against the goal' : 'Revenue won, month by month',
      chartSub: view === 'goal' ? 'Won so far, and where this pace would end the month' : 'The last 12 months; October so far',
      bigV: view === 'goal' ? inr(sofar[today]) : inrShort(mv.slice(0, 11).reduce((a, b) => a + b, 0)),
      bigChip: 'tchip good', bigDelta: view === 'goal' ? 'On pace for ' + inrShort(projEnd) : '+31%',
      bigWords: view === 'goal' ? `of ${inrShort(goal)} · 3 days in` : 'over the 11 months before October, against the year before',
      gridY: [0, 0.25, 0.5, 0.75].map((f) => { const y = 8 + f * (H - 12); return { y: y.toFixed(1), ty: (y - 4).toFixed(1), label: inrShort((view === 'goal' ? max : mmax) * (1 - f)) }; }),
      goalD: `M${xOf(0)},${yOf(0)} L${xOf(daysIn)},${yOf(goal)}`, goalTy: (yOf(goal) - 6).toFixed(1), goalV: inrShort(goal),
      lineD: line, areaD: `${line} L${xOf(today)},${H} L${xOf(0)},${H} Z`,
      paceD: `M${xOf(today)},${yOf(sofar[today])} L${xOf(daysIn)},${yOf(projEnd)}`,
      todayX: xOf(today).toFixed(1),
      bars: mv.map((v, i) => { const h = (v / mmax) * (H - 12); return { x: (10 + i * ((W - 20) / 12) + 7).toFixed(1), w: bw.toFixed(1), y: (H - 4 - h).toFixed(1), h: h.toFixed(1), fill: i === 11 ? 'rgba(42,91,255,.35)' : 'url(#barfill)', i: `--i:${i}` }; }),
      xl: view === 'goal' ? [1, 8, 15, 22, 29].map((d) => ({ x: xOf(d).toFixed(1), label: `Oct ${d}` })) : months.map((m, i) => ({ x: (10 + i * ((W - 20) / 12) + 7 + bw / 2).toFixed(1), label: m })),
      slices: PKGS.map((p, i) => ({ color: p[1], cls: 'sl' + (hot === i ? ' hot' : hot != null ? ' dim' : ''), st: `stroke-dasharray:${sl[i].dash};--o:${sl[i].off};stroke-dashoffset:${sl[i].off};--i:${i}` })),
      hotV: hot == null ? inrShort(total) : inrShort(PKGS[hot][3]), hotL: hot == null ? 'won in all' : `${PKGS[hot][0]} · ${pctS(PKGS[hot][3] / total)}`,
      pkgs: PKGS.map((p, i) => ({ cls: 'dlr' + (hot === i ? ' hot' : ''), sw: `background:${p[1]}`, name: p[0], deals: `${p[2]} deals · avg ${inrShort(p[3] / p[2])}`, v: inrShort(p[3]), share: pctS(p[3] / total), on: () => this.setState({ hot: i }), off: () => this.setState({ hot: null }) })),
      sources: SOURCES.map((x, i) => {
        const [name, kind, ab, color, leads, won, rev, spend] = x;
        const has = spend !== null && spend > 0;
        const roi = has ? rev / spend : 0;
        return { i: `--i:${i}`, name, kind, ab, bg: `background:${color}`, leads: fmt(leads), won: fmt(won), conv: pctS(won / leads, 1), cw: `width:${Math.min(100, (won / leads / 0.15) * 100)}%;--i:${i}`, rev: inrShort(rev), hasSpend: has || spend === 0, noSpend: spend === null, spend: spend === 0 ? 'Free' : inr(spend), cpl: has ? inr(spend / leads) : spend === 0 ? '₹0' : '—', roi: has ? `₹${roi.toFixed(1).replace(/\.0$/, '')}` : 'Free', roiCls: 'roi ' + (!has ? 'hi' : roi >= 8 ? 'hi' : roi < 3 ? 'lo' : 'mid') };
      }),
    };
  }
}

module.exports={Component};
