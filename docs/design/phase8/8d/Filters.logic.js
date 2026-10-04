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
const PEOPLE = [['Riya Shah', 'RS', '#e35d8f', 'Inbound', 1120], ['Dev Malhotra', 'DM', '#3d8bd9', 'Inbound', 980], ['Sana Qureshi', 'SQ', '#c98a0b', 'Inbound', 760], ['Hana Ito', 'HI', '#18a566', 'Field', 720], ['Leo Martins', 'LM', '#6b7385', 'Field', 600]];
const TEAMS = [['Inbound', 'IN', '#2a5bff', '3 people', 2860], ['Field', 'FD', '#18a566', '2 people', 1320]];
const SRCS = [['Instagram ads', '#2a5bff', .43], ['Website form', '#5ab8ff', .3], ['Referrals', '#18a566', .1], ['Webinars', '#f2a20c', .08], ['Google ads', '#e35d8f', .07], ['Calendly', '#8a94a6', .02]];
const TAGS = [['café', .12], ['wedding', .09], ['repeat client', .06], ['corporate', .1], ['urgent', .05]];
const BUDGET = [['Under ₹1 L', .3], ['₹1–3 L', .45], ['Over ₹3 L', .25]];
const ALL = 4180;
// Tags and fields read live up to 92 days, so this board offers a 90-day range.
if (!RANGES.some((r) => r.id === '90d')) RANGES.splice(3, 0, { id: '90d', label: 'Last 90 days', days: 90, words: 'Last 90 days', vs: 'vs the 90 before' });
const fmtN = (n) => Math.round(n).toLocaleString('en-IN');
const lakh = (n) => `₹${(n / 100000).toFixed(1).replace(/\.0$/, '')} L`;
class Component extends DCLogic {
  constructor(p) {
    super(p);
    const sc = p.scene;
    this.state = { themePick: 'auto', range: sc === 'range too long for tags' ? '12m' : '30d', compare: true,
      open: sc !== 'filters applied', pipe: 'sales', pt: 'people',
      who: { 'Riya Shah': true, 'Dev Malhotra': true }, src: { 'Instagram ads': true, 'Website form': true },
      tags: { 'café': sc !== 'choosing filters' }, field: sc === 'choosing filters', budget: { '₹1–3 L': true } };
  }
  renderVals() {
    const s = this.state;
    const R = RANGES.find((x) => x.id === s.range);
    const tooLong = R.days > 92;
    const toggle = (k, name) => () => this.setState({ [k]: { ...s[k], [name]: !s[k][name] } });
    const whoOn = Object.keys(s.who).filter((k) => s.who[k]);
    const srcOn = Object.keys(s.src).filter((k) => s.src[k]);
    const tagOn = Object.keys(s.tags).filter((k) => s.tags[k]);
    const budOn = s.field ? Object.keys(s.budget).filter((k) => s.budget[k]) : [];
    const liveAny = tagOn.length > 0 || budOn.length > 0;
    // how much of the business the filters keep (rough shares, for the drawing)
    const list = s.pt === 'people' ? PEOPLE : TEAMS;
    let share = whoOn.length ? list.filter((p) => s.who[p[0]]).reduce((a, p) => a + p[4], 0) / ALL : 1;
    share *= srcOn.length ? SRCS.filter((x) => s.src[x[0]]).reduce((a, x) => a + x[2], 0) : 1;
    if (!tooLong) {
      if (tagOn.length) share *= TAGS.filter((x) => s.tags[x[0]]).reduce((a, x) => a + x[1], 0) * 3.2;
      if (budOn.length) share *= BUDGET.filter((x) => s.budget[x[0]]).reduce((a, x) => a + x[1], 0);
    }
    share = Math.min(1, share);
    const cover = Math.max(1, Math.round(ALL * share));
    const sc2 = (n) => Math.max(0, Math.round(n * share));
    const tiles = [
      ['New leads', fmtN(sc2(4180)), '', 'tchip good', '+12%'], ['Contacted', '91', '%', 'tchip good', '+3 pts'], ['Reply rate', '47', '%', 'tchip good', '+2 pts'],
      ['Calls booked', fmtN(sc2(612)), '', 'tchip good', '+8%'], ['Calls held', fmtN(sc2(498)), '', 'tchip good', '+6%'], ['Revenue won', lakh(sc2(5840000)), '', 'tchip solid good', '+19%'],
      ['Won', fmtN(sc2(176)), '', 'tchip good', '+19%'], ['Win rate', '4.2', '%', 'tchip good', '+0.4 pts'], ['Average deal', lakh(33200), '', 'tchip flat', 'No change'],
      ['Speed to lead', '38', 'min', 'tchip good', '−6 min'], ['Follow-ups overdue', fmtN(sc2(23)), '', 'tchip flat', 'Right now'], ['Pipeline forecast', lakh(sc2(9100000)), '', 'tchip flat', 'Right now'],
    ].map(([label, v, unit, chip, delta], i) => ({ label, v, unit, chip, delta, cls: 'kt' + (i === 5 ? ' hero' : '') }));
    const names = (xs) => xs.length <= 2 ? xs.join(' and ') : `${xs.slice(0, 2).join(', ')} and ${xs.length - 2} more`;
    const firstNames = whoOn.map((n) => n.split(' ')[0]);
    const chipsOn = [];
    if (s.pipe !== 'sales') chipsOn.push({ k: 'Pipeline', v: 'Partnerships', cls: 'fchip2', remove: () => this.setState({ pipe: 'sales' }) });
    if (whoOn.length) chipsOn.push({ k: s.pt === 'people' ? 'People' : 'Teams', v: names(firstNames), cls: 'fchip2', remove: () => this.setState({ who: {} }) });
    if (srcOn.length) chipsOn.push({ k: 'Source', v: names(srcOn), cls: 'fchip2', remove: () => this.setState({ src: {} }) });
    if (tagOn.length) chipsOn.push({ k: 'Tag', v: names(tagOn), live: true, liveWord: tooLong ? 'Paused' : 'Live', cls: 'fchip2' + (tooLong ? ' paused' : ''), remove: () => this.setState({ tags: {} }) });
    if (budOn.length) chipsOn.push({ k: 'Budget', v: names(budOn), live: true, liveWord: tooLong ? 'Paused' : 'Live', cls: 'fchip2' + (tooLong ? ' paused' : ''), remove: () => this.setState({ field: false }) });
    const subBits = [whoOn.length ? `${names(firstNames)}'s leads` : 'Every lead', srcOn.length ? `from ${names(srcOn)}` : '', tagOn.length && !tooLong ? `tagged ${names(tagOn)}` : ''].filter(Boolean).join(' ');
    return {
      ...themeVals(this), ...rangeVals(this),
      filterN: String(chipsOn.length), filtCls: 'rbtn' + (chipsOn.length ? ' fon' : '') + (s.open ? ' open' : ''), filtOpen: s.open ? 'true' : 'false',
      openFilters: () => this.setState({ open: !s.open }), closePanel: () => this.setState({ open: false }), panel: s.open,
      hasFilters: chipsOn.length > 0, chipsOn,
      clearAll: () => this.setState({ who: {}, src: {}, tags: {}, field: false, pipe: 'sales' }),
      headline: chipsOn.length ? 'A strong month for these leads.' : 'A strong month.',
      subline: `${subBits} · ${fmtN(cover)} of ${fmtN(ALL)} leads`,
      gridCls: 'kgrid' + (s.open ? ' busy' : ''), tiles, seriesSub: 'Per day · dashed: the period before',
      plKnob: `width:118px;transform:translateX(${s.pipe === 'sales' ? 0 : 118}px)`, plSales: s.pipe === 'sales' ? 'on' : '', plPart: s.pipe === 'sales' ? '' : 'on', plA: s.pipe === 'sales' ? 'true' : 'false', plB: s.pipe === 'sales' ? 'false' : 'true',
      pickSales: () => this.setState({ pipe: 'sales' }), pickPart: () => this.setState({ pipe: 'partners' }),
      ptKnob: `width:${s.pt === 'people' ? 82 : 76}px;transform:translateX(${s.pt === 'people' ? 0 : 82}px)`, ptPeople: s.pt === 'people' ? 'on' : '', ptTeams: s.pt === 'people' ? '' : 'on', ptP: s.pt === 'people' ? 'true' : 'false', ptT: s.pt === 'people' ? 'false' : 'true',
      pickPeople: () => this.setState({ pt: 'people', who: {} }), pickTeams: () => this.setState({ pt: 'teams', who: {} }),
      whoList: list.map(([name, ini, c, grp]) => ({ name, ini, grp, sw: `background:${c}`, on: !!s.who[name], toggle: toggle('who', name) })),
      srcList: SRCS.map(([name, c]) => ({ name, sw: `background:${c}`, cls: 'chip' + (s.src[name] ? ' on' : ''), on: s.src[name] ? 'true' : 'false', toggle: toggle('src', name) })),
      tagList: TAGS.map(([name]) => ({ name, cls: 'chip' + (s.tags[name] ? ' on' : ''), on: s.tags[name] ? 'true' : 'false', toggle: toggle('tags', name) })),
      fieldOn: s.field, addField: () => this.setState({ field: true }), dropField: () => this.setState({ field: false }),
      budget: BUDGET.map(([name]) => ({ name, cls: 'chip' + (s.budget[name] ? ' on' : ''), on: s.budget[name] ? 'true' : 'false', toggle: toggle('budget', name) })),
      liveOk: liveAny && !tooLong, liveTooLong: liveAny && tooLong, rangeOkWords: `${R.words} is fine.`,
      use90: () => this.setState({ range: '90d' }),
      coverN: fmtN(cover), allN: fmtN(ALL),
    };
  }
}

module.exports={Component};
