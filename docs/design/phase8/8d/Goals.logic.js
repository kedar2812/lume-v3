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
const LAST = { revenue: 5840000, won: 112, held: 141, leads: 4180, ontime: 89 };
const NOW = { revenue: 640000, won: 9, held: 14, leads: 410, ontime: 92 };
const TODAY_D = 3, MONTH_D = 31;
const METRICS = [
  ['revenue', 'Revenue won', 'Value of leads won in the period', '₹', '', 'Sep:'],
  ['won', 'Won', 'Leads moved to Won in the period', '', 'leads', 'Sep:'],
  ['held', 'Calls held', 'Meetings with leads that took place', '', 'calls', 'Sep:'],
  ['leads', 'New leads', 'Leads that arrived in the period', '', 'leads', 'Sep:'],
  ['ontime', 'Follow-ups on time', 'Done by their due time, of those due', '', '%', 'Sep:'],
];
const TEAMS = [['Inbound', 'IN', '#2a5bff', 'Riya, Dev and Sana', 64, 3310000, 78], ['Field', 'FD', '#18a566', 'Hana and Leo', 48, 2530000, 63]];
const PEOPLE = [
  ['Riya Shah', 'RS', '#e35d8f', 'Inbound', 27, 1420000, 31],
  ['Dev Malhotra', 'DM', '#5ab8ff', 'Inbound', 22, 1110000, 26],
  ['Sana Qureshi', 'SQ', '#f2a20c', 'Inbound', 15, 780000, 21],
  ['Hana Ito', 'HI', '#18a566', 'Field', 26, 1450000, 34],
  ['Leo Martins', 'LM', '#8a94a6', 'Field', 22, 1080000, 29],
];
const grp = (n) => Math.round(n).toLocaleString('en-IN');
const lakh = (n) => n >= 10000000 ? `₹${(n / 10000000).toFixed(2).replace(/\.?0+$/, '')} Cr` : `₹${(n / 100000).toFixed(1).replace(/\.0$/, '')} L`;
const num = (v) => { const n = Number(String(v).replace(/[^0-9.]/g, '')); return Number.isFinite(n) && n > 0 ? n : null; };
const show = (k, n) => n == null ? '' : (k === 'revenue' ? grp(n) : String(Math.round(n)));
const C = 2 * Math.PI * 40;
class Component extends DCLogic {
  constructor(p) {
    super(p);
    this.state = { themePick: 'auto', period: 'month', step: 0, started: false,
      biz: { revenue: 6200000, won: 120, held: 150, leads: 4500, ontime: 90 },
      teams: { Inbound: { won: 68, rev: 3500000, held: 84 }, Field: { won: 52, rev: 2700000, held: 66 } },
      people: { 'Riya Shah': { won: 28, rev: 1500000, held: 33 }, 'Dev Malhotra': { won: 24, rev: 1200000, held: 28 }, 'Sana Qureshi': { won: 16, rev: 800000, held: 23 }, 'Hana Ito': { won: 28, rev: 1550000, held: 36 }, 'Leo Martins': { won: 24, rev: 1150000, held: 30 } },
      saved: 0 };
  }
  renderVals() {
    const s = this.state;
    const first = (this.props.scene === 'first time') && !s.started;
    const q = s.period === 'quarter';
    const months = ['September 2026', 'October 2026', 'November 2026', 'December 2026'];
    const quarters = ['Jul – Sep 2026', 'Oct – Dec 2026', 'Jan – Mar 2027'];
    const periodWords = q ? quarters[Math.max(0, Math.min(2, 1 + s.step))] : months[Math.max(0, Math.min(3, 1 + s.step))];
    const touch = () => this.setState({ saved: Date.now() });
    const setBiz = (k) => (e) => { this.setState({ biz: { ...s.biz, [k]: num(e.target.value) } }); touch(); };
    const biz = METRICS.map(([k, label, def, pre, suf, lw]) => {
      const lastV = q ? LAST[k] * (k === 'ontime' ? 1 : 3) : LAST[k];
      return {
        label, def, pre, suf: suf === '%' ? '%' : '', aria: `${label} goal`,
        inpCls: 'ginp' + (pre ? ' has-pre' : '') + (suf === '%' ? ' has-suf' : ''),
        val: show(k, s.biz[k]), set: setBiz(k), lastWord: q ? 'Last quarter:' : lw,
        last: k === 'revenue' ? lakh(lastV) : k === 'ontime' ? `${lastV}%` : grp(lastV),
        match: () => { this.setState({ biz: { ...s.biz, [k]: lastV } }); touch(); },
        up10: () => { this.setState({ biz: { ...s.biz, [k]: k === 'ontime' ? Math.min(100, lastV + 5) : Math.round(lastV * 1.1 / (k === 'revenue' ? 10000 : 1)) * (k === 'revenue' ? 10000 : 1) } }); touch(); },
      };
    });
    const setT = (n, f) => (e) => { this.setState({ teams: { ...s.teams, [n]: { ...s.teams[n], [f]: num(e.target.value) } } }); touch(); };
    const teams = TEAMS.map(([name, ini, c, ppl, lw, lr, lh]) => ({ name, ini, sw: `background:${c}`, people: ppl,
      won: show('won', s.teams[name].won), rev: show('revenue', s.teams[name].rev), held: show('held', s.teams[name].held),
      lwon: lw, lrev: lakh(lr), lheld: lh, setWon: setT(name, 'won'), setRev: setT(name, 'rev'), setHeld: setT(name, 'held') }));
    const setP = (n, f) => (e) => { this.setState({ people: { ...s.people, [n]: { ...s.people[n], [f]: num(e.target.value) } } }); touch(); };
    const people = PEOPLE.map(([name, ini, c, team, lw, lr, lh]) => ({ name, ini, team, sw: `background:${c}`,
      won: show('won', s.people[name].won), rev: show('revenue', s.people[name].rev), held: show('held', s.people[name].held),
      lwon: lw, lrev: lakh(lr), lheld: lh, setWon: setP(name, 'won'), setRev: setP(name, 'rev'), setHeld: setP(name, 'held') }));
    const sumWon = PEOPLE.reduce((a, p) => a + (s.people[p[0]].won || 0), 0);
    const sumRev = PEOPLE.reduce((a, p) => a + (s.people[p[0]].rev || 0), 0);
    const bw = s.biz.won, br = s.biz.revenue;
    const peopleSum = `Adds up to ${sumWon} won${bw ? ` of ${bw}` : ''} · ${lakh(sumRev)}${br ? ` of ${lakh(br)}` : ''}`;
    const shareOut = () => {
      const tot = PEOPLE.reduce((a, p) => a + p[4], 0);
      const next = {};
      for (const p of PEOPLE) next[p[0]] = { ...s.people[p[0]], won: bw ? Math.round(bw * p[4] / tot) : s.people[p[0]].won, rev: br ? Math.round(br * p[4] / tot / 10000) * 10000 : s.people[p[0]].rev };
      this.setState({ people: next }); touch();
    };
    // the preview, from what's typed
    const share = q ? (TODAY_D / 92) : (TODAY_D / MONTH_D);
    const pctOf = (v, t) => t ? v / t : 0;
    const rp = pctOf(NOW.revenue, br);
    const pace = br ? (NOW.revenue / share) / br : 0;
    const bar = (label, v, t, unit) => ({ label, cls: 'pb' + (t && v / share >= t ? ' ok3' : ''), text: t ? `${grp(v)} of ${grp(t)}${unit}` : 'No goal', w: `width:${Math.min(100, pctOf(v, t) * 100)}%` });
    const mName = periodWords.split(' ')[0];
    return {
      ...themeVals(this), first, set: !first,
      pKnob: `width:${q ? 84 : 74}px;transform:translateX(${q ? 74 : 0}px)`, pMonth: q ? '' : 'on', pQuarter: q ? 'on' : '', isMonth: q ? 'false' : 'true', isQuarter: q ? 'true' : 'false',
      pickMonth: () => this.setState({ period: 'month', step: 0 }), pickQuarter: () => this.setState({ period: 'quarter', step: 0 }),
      prev: () => this.setState({ step: s.step - 1 }), next: () => this.setState({ step: s.step + 1 }), periodWords,
      savedWords: s.saved ? 'Saved' : 'Saved · October 1',
      startFromLast: () => this.setState({ started: true, biz: { revenue: LAST.revenue, won: null, held: null, leads: null, ontime: null } }),
      startBlank: () => this.setState({ started: true, biz: { revenue: null, won: null, held: null, leads: null, ontime: null } }),
      biz, teams, people, peopleSum, shareOut,
      monthName: q ? 'This quarter' : mName, periodNoun: q ? 'quarter' : 'month',
      ringPct: br ? `${Math.round(rp * 100)}%` : '—',
      ringArc: `stroke-dasharray:${C};stroke-dashoffset:${C * (1 - Math.min(1, rp))}`,
      paceArc: `stroke-dasharray:2 3;opacity:${br ? 1 : 0}`,
      bars: [bar('Won', NOW.won, s.biz.won, ''), bar('Calls held', NOW.held, s.biz.held, ''), bar('New leads', NOW.leads, s.biz.leads, '')],
      paceWords: br ? `${Math.round(pace * 100)}% of the revenue goal (an estimate)` : 'set a revenue goal to see it',
      mailRows: [
        { l: 'Revenue won', v: br ? `${lakh(NOW.revenue)} of ${lakh(br)} (${Math.round(rp * 100)}%)` : lakh(NOW.revenue) },
        { l: 'Won', v: s.biz.won ? `${NOW.won} of ${s.biz.won}` : String(NOW.won) },
        { l: 'At this pace', v: br ? `${Math.round(pace * 100)}% of goal` : '—' },
      ],
      riyaWon: s.people['Riya Shah'].won ? `${s.people['Riya Shah'].won} won · ${lakh(s.people['Riya Shah'].rev || 0)}` : 'no personal goal',
    };
  }
}

module.exports={Component};
