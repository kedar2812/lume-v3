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
const REPS = [
  { id: 'rs', name: 'Riya Shah', ini: 'RS', color: '#0B7285', team: 'Inbound', assigned: 968, contacted: 0.93, speed: 9, within: 0.71, reply: 0.46, held: 152, won: 71, revenue: 3120000, ontime: 0.97, overdue: 1, goal: [71, 70], prev: { won: 58, revenue: 2410000, speed: 12, ontime: 0.95, reply: 0.43 } },
  { id: 'hi', name: 'Hana Ito', ini: 'HI', color: '#0F7F44', team: 'Inbound', assigned: 901, contacted: 0.9, speed: 11, within: 0.66, reply: 0.44, held: 141, won: 63, revenue: 2860000, ontime: 0.95, overdue: 2, goal: [63, 70], prev: { won: 61, revenue: 2700000, speed: 11, ontime: 0.94, reply: 0.42 } },
  { id: 'dm', name: 'Dev Malhotra', ini: 'DM', color: '#A15C00', team: 'Outbound', assigned: 844, contacted: 0.84, speed: 21, within: 0.48, reply: 0.38, held: 118, won: 49, revenue: 2340000, ontime: 0.86, overdue: 9, goal: [49, 60], prev: { won: 52, revenue: 2290000, speed: 17, ontime: 0.9, reply: 0.39 } },
  { id: 'lm', name: 'Leo Martins', ini: 'LM', color: '#B02E6B', team: 'Outbound', assigned: 712, contacted: 0.81, speed: 26, within: 0.41, reply: 0.35, held: 96, won: 38, revenue: 1690000, ontime: 0.79, overdue: 11, goal: [38, 50], prev: { won: 31, revenue: 1320000, speed: 31, ontime: 0.81, reply: 0.31 } },
  { id: 'ak', name: 'Asha Kulkarni', ini: 'AK', color: '#C62A30', team: 'Inbound', assigned: 236, contacted: 0.95, speed: 6, within: 0.82, reply: 0.49, held: 34, won: 11, revenue: 520000, ontime: 1, overdue: 0, goal: [11, 10], prev: { won: 0, revenue: 0, speed: 0, ontime: 0, reply: 0 }, isNew: true },
  { id: 'nm', name: 'Neil Mendes', ini: 'NM', color: '#2A5BFF', team: 'Outbound', assigned: 149, contacted: 0.77, speed: 34, within: 0.33, reply: 0.31, held: 0, won: 0, revenue: 0, ontime: 0.74, overdue: 0, goal: [0, 10], prev: { won: 2, revenue: 80000, speed: 29, ontime: 0.8, reply: 0.33 } },
];
const METRICS = [
  { id: 'won', label: 'Won', w: 58, good: 'up', val: (r) => r.won, show: (v) => fmt(v), words: 'Most leads won' },
  { id: 'revenue', label: 'Revenue', w: 80, good: 'up', val: (r) => r.revenue, show: (v) => inrShort(v), words: 'Most revenue won' },
  { id: 'speed', label: 'Speed', w: 64, good: 'down', val: (r) => r.speed, show: (v) => `${v} min`, words: 'Fastest median first contact (lower is better)' },
  { id: 'ontime', label: 'On time', w: 74, good: 'up', val: (r) => r.ontime, show: (v) => pctS(v), words: 'Most follow-ups done on time' },
  { id: 'reply', label: 'Replies', w: 72, good: 'up', val: (r) => r.reply, show: (v) => pctS(v), words: 'Highest reply rate' },
];
const COLS = [
  ['Person', null], ['Assigned', 'assigned'], ['Contacted', 'contacted'], ['Speed to lead', 'speed'], ['Within 1 h', 'within'], ['Reply rate', 'reply'],
  ['Calls held', 'held'], ['Won', 'won'], ['Revenue', 'revenue'], ['Last 14 days', null], ['Goal', null],
];
class Component extends DCLogic {
  constructor(p) { super(p); this.state = { themePick: 'auto', range: '30d', compare: true, sort: 'won', dir: -1 }; }
  renderVals() {
    const s = this.state;
    const R = RANGES.find((x) => x.id === s.range);
    const mid = s.rank ?? this.props.rankBy ?? 'won';
    const M = METRICS.find((m) => m.id === mid);
    const ranked = REPS.slice().sort((a, b) => (M.good === 'up' ? M.val(b) - M.val(a) : (M.val(a) || 999) - (M.val(b) || 999)));
    const best = M.good === 'up' ? M.val(ranked[0]) : Math.max(...REPS.map(M.val));
    let x = 0;
    const knobAt = METRICS.map((m) => { const at = x; x += m.w; return at; });
    const mi = METRICS.indexOf(M);
    // best first by default (fastest for speed); clicking the heading again turns it round
    const sorted = REPS.slice().sort((a, b) => { const d = s.sort === 'speed' ? a.speed - b.speed : b[s.sort] - a[s.sort]; return s.dir < 0 ? d : -d; });
    return {
      ...themeVals(this), ...rangeVals(this), filterN: '0',
      rankWords: `${M.words}, ${R.words.toLowerCase()}`, rangeLower: R.words.toLowerCase().replace(/^last/, 'in the last'),
      rKnob: `width:${M.w}px;transform:translateX(${knobAt[mi]}px)`,
      metrics: METRICS.map((m) => ({ label: m.label, w: `width:${m.w}px`, cls: m.id === mid ? 'on' : '', pick: () => this.setState({ rank: m.id }) })),
      // each person keeps their row element; only its place changes, so it slides
      board: REPS.map((r) => {
        const rank = ranked.indexOf(r);
        const v = M.val(r);
        const t = r.isNew ? { text: 'New', tone: 'good' } : trend(v, M.val(r.prev), { kind: mid === 'speed' ? 'abs' : mid === 'ontime' || mid === 'reply' ? 'pts' : 'pct', good: M.good, unit: mid === 'speed' ? 'min' : '' });
        const frac = M.good === 'up' ? v / (best || 1) : v ? Math.min(...REPS.filter((q) => q.speed).map((q) => q.speed)) / v : 0;
        return { cls: 'lr' + (rank === 0 ? ' first' : ''), y: `transform:translateY(${rank * 54}px)`, rank: String(rank + 1), ini: r.ini, bg: `background:${r.color}`, name: r.name, team: r.team, w: `width:${Math.max(2, frac * 100)}%`, v: M.show(v), chip: 'tchip ' + t.tone, delta: t.text };
      }),
      disc: REPS.slice().sort((a, b) => b.ontime - a.ontime).map((r, i) => ({ i: `--i:${i}`, ini: r.ini, bg: `background:${r.color}`, w: `width:${r.ontime * 100}%;background:${r.ontime >= 0.9 ? 'linear-gradient(90deg,#18a566,#4fd69c)' : r.ontime >= 0.8 ? 'linear-gradient(90deg,#f2a20c,#ffc75c)' : 'linear-gradient(90deg,#e5484d,#ff8a8e)'}`, pc: pctS(r.ontime), od: r.overdue ? `${r.overdue} overdue` : 'none', odCls: 'od ' + (r.overdue > 5 ? 'red' : 'ok') })),
      heads: COLS.map(([label, key]) => ({ label, cls: key && s.sort === key ? 'on' : '', arrow: key && s.sort === key ? (s.dir < 0 ? 'M3 4.5 6 7.5l3-3' : 'M3 7.5 6 4.5l3 3') : '', sort: () => key && this.setState({ sort: key, dir: s.sort === key ? -s.dir : -1 }) })),
      rows: sorted.map((r) => {
        const rr = rng(r.assigned);
        const v = Array.from({ length: 14 }, (_, i) => 8 + rr() * 10 + (r.won / 10) * Math.sin(i / 2));
        const g = r.goal[0] / r.goal[1];
        return {
          ini: r.ini, bg: `background:${r.color}`, name: r.name, assigned: fmt(r.assigned), contacted: pctS(r.contacted),
          speed: `${r.speed} min`, speedCls: r.speed <= 12 ? 'goodv' : r.speed >= 25 ? 'badv' : '', within: pctS(r.within), reply: pctS(r.reply),
          held: fmt(r.held), won: fmt(r.won), revenue: r.revenue ? inrShort(r.revenue) : '—', spark: smooth(toPts(v, 88, 26, 30, 2)),
          goal: `${r.goal[0]} of ${r.goal[1]}`, goalW: `width:${Math.min(1, g) * 100}%`, goalCls: 'goalm' + (g >= 1 ? ' hit' : ''),
        };
      }),
    };
  }
}

module.exports={Component};
