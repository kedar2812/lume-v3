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
const SOURCES = [
  { id: 'ig', label: 'Instagram', color: '#2a5bff' },
  { id: 'web', label: 'Website', color: '#5ab8ff' },
  { id: 'ref', label: 'Referrals', color: '#18a566' },
  { id: 'evt', label: 'Webinars', color: '#f2a20c' },
];
const N = 30, W = 640, H = 216;
const STAGE_C = { New: '#8a94a6', Contacted: '#2a5bff', Replied: '#5ab8ff', 'Call booked': '#5ab8ff', Proposal: '#f2a20c', Won: '#18a566' };
const PEOPLE = [['Aarav Mehta', 'Won', 'Riya Shah', 64000], ['Lena Fischer', 'Won', 'Dev Malhotra', 38000], ['Tomás Rivera', 'Won', 'Hana Ito', 52000], ['Mei Lin', 'Won', 'Riya Shah', 29000], ['Omar Haddad', 'Won', 'Leo Martins', 41000], ['Priya Nair', 'Won', 'Hana Ito', 36000], ['Jonas Berg', 'Won', 'Dev Malhotra', 88000], ['Sara Okafor', 'Won', 'Riya Shah', 24000], ['Kenji Sato', 'Won', 'Leo Martins', 47000], ['Ana Costa', 'Won', 'Hana Ito', 31000], ['Mateo Silva', 'Won', 'Riya Shah', 56000], ['Amara Obi', 'Won', 'Dev Malhotra', 33000]];

// A made-up business: daily arrivals by source with a weekly rhythm and steady growth.
function series(rangeId, slow) {
  const days = { today: 1, '7d': 7, '30d': 30, month: 3, lastmonth: 30, quarter: 95, '12m': 365 }[rangeId] || 30;
  const r = rng(7 + days);
  const pts = Math.max(8, Math.min(days, 60));
  const base = { ig: 58, web: 41, ref: 17, evt: 11 };
  const out = {};
  for (const s of SOURCES) {
    const vals = [];
    for (let i = 0; i < pts; i++) {
      const dow = (i + 3) % 7;
      const weekly = dow >= 5 ? 0.72 : 1 + (dow === 1 ? 0.12 : 0);
      const grow = 0.85 + (0.3 * i) / pts;
      const spike = s.id === 'evt' && i % 11 === 6 ? 2.6 : 1;
      vals.push(base[s.id] * weekly * grow * spike * (0.86 + r() * 0.28) * (slow ? 0.78 : 1) * (days >= 365 ? 30 : days >= 95 ? 7 : 1));
    }
    out[s.id] = resample(vals, N);
  }
  return { days, out };
}
function numbers(rangeId, slow) {
  const d = { today: 1, '7d': 7, '30d': 30, month: 3, lastmonth: 30, quarter: 95, '12m': 365 }[rangeId] || 30;
  const k = slow ? 0.8 : 1;
  const leads = Math.round(127 * d * k), won = Math.round(leads * (slow ? 0.049 : 0.061));
  const cur = { leads, contacted: slow ? 0.81 : 0.86, reply: slow ? 0.36 : 0.41, booked: Math.round(leads * 0.18), held: Math.round(leads * 0.142), won, winRate: slow ? 0.049 : 0.061, revenue: won * (slow ? 36000 : 41200), deal: slow ? 36000 : 41200, speed: slow ? 23 : 14, overdue: slow ? 41 : 23, forecast: 4810000 * (slow ? 0.82 : 1) };
  const prev = { leads: Math.round(leads * (slow ? 1.12 : 0.89)), contacted: slow ? 0.84 : 0.83, reply: slow ? 0.4 : 0.39, booked: Math.round(leads * 0.167 * (slow ? 1.1 : 0.9)), held: Math.round(leads * 0.13 * (slow ? 1.1 : 0.9)), won: Math.round(won * (slow ? 1.3 : 0.84)), winRate: slow ? 0.057 : 0.058, revenue: won * (slow ? 1.3 : 0.84) * (slow ? 38500 : 40100), deal: slow ? 38500 : 40100, speed: slow ? 16 : 19, overdue: slow ? 22 : 31, forecast: cur.forecast * (slow ? 1.11 : 0.93) };
  return { cur, prev };
}

class Component extends DCLogic {
  constructor(p) {
    super(p);
    this.seen = p.scene ?? 'first visit';
    this.state = this.sceneState(this.seen);
    this.later = [];
  }
  componentWillUnmount() { this.later.forEach(clearTimeout); }
  sceneState(sc) {
    return {
      themePick: (this.state || {}).themePick || 'auto', range: sc === 'last 12 months' ? '12m' : '30d', compare: true, rangeOpen: false,
      first: sc === 'first visit', hidden: {}, hi: null, drill: sc === 'drill into revenue won' ? 'revenue' : null, slow: sc === 'a slow month',
    };
  }
  onRange() { this.setState({ first: false, hi: null }); }
  renderVals() {
    const sc = this.props.scene ?? 'first visit';
    if (sc !== this.seen) { this.seen = sc; this.later.push(setTimeout(() => this.setState(this.sceneState(sc)), 0)); }
    const s = this.state;
    const R = RANGES.find((x) => x.id === s.range);
    const { out } = series(s.range, s.slow);
    const prevS = series(s.range === '12m' ? 'quarter' : s.range, !s.slow);
    const { cur, prev } = numbers(s.range, s.slow);
    const cmp = s.compare !== false;
    const drill = (key) => () => this.setState({ drill: key });
    const sparkOf = (seed, up) => { const r = rng(seed); const v = Array.from({ length: 14 }, (_, i) => 10 + (up ? i : 14 - i) * 0.8 + r() * 6); const p = toPts(v, 120, 44, Math.max(...v) * 1.1, 2); const l = smooth(p); return { line: l, area: areaOf(l, 120, 44) }; };
    const K = [
      { key: 'leads', label: 'New leads', v: fmt(cur.leads), t: trend(cur.leads, prev.leads) },
      { key: 'contacted', label: 'Contacted', v: pctS(cur.contacted), t: trend(cur.contacted, prev.contacted, { kind: 'pts' }) },
      { key: 'reply', label: 'Reply rate', v: pctS(cur.reply), t: trend(cur.reply, prev.reply, { kind: 'pts' }) },
      { key: 'booked', label: 'Calls booked', v: fmt(cur.booked), t: trend(cur.booked, prev.booked) },
      { key: 'held', label: 'Calls held', v: fmt(cur.held), t: trend(cur.held, prev.held) },
      { key: 'revenue', label: 'Revenue won', v: inrShort(cur.revenue), t: trend(cur.revenue, prev.revenue), hero: true },
      { key: 'won', label: 'Won', v: fmt(cur.won), t: trend(cur.won, prev.won) },
      { key: 'winRate', label: 'Win rate', v: pctS(cur.winRate, 1), t: trend(cur.winRate, prev.winRate, { kind: 'pts' }) },
      { key: 'deal', label: 'Average deal', v: inrShort(cur.deal), t: trend(cur.deal, prev.deal) },
      { key: 'speed', label: 'Speed to lead (median)', v: String(cur.speed), unit: 'min', t: trend(cur.speed, prev.speed, { kind: 'abs', good: 'down', unit: 'min' }) },
      { key: 'overdue', label: 'Follow-ups overdue now', v: String(cur.overdue), t: trend(cur.overdue, prev.overdue, { kind: 'abs', good: 'down' }), alarm: cur.overdue > 0 },
      { key: 'forecast', label: 'Pipeline forecast', v: inrShort(cur.forecast), t: trend(cur.forecast, prev.forecast) },
    ];
    const kpis = K.map((k, i) => {
      const sp = sparkOf(11 + i * 7, k.t.dir !== 'down');
      return {
        cls: 'kt' + (k.hero ? ' hero' : '') + (k.alarm ? ' alarm' : '') + (s.first ? ' in2' : ''), i: `--i:${i}`, label: k.label, odo: odoStr(k.v, 7), unit: k.unit || '',
        chip: cmp ? chipCls(k.t) + (k.hero ? ' solid' : '') : 'tchip flat' + (k.hero ? ' solid' : ''), up: cmp && k.t.dir === 'up', down: cmp && k.t.dir === 'down', flat: !cmp || k.t.dir === 'flat', delta: cmp ? k.t.text : R.words, aria: `${k.label}: ${k.v}. ${cmp ? k.t.text + ' ' + R.vs : ''}. See the leads.`,
        line: sp.line, area: sp.area, drill: drill(k.key),
      };
    });
    // the stacked bands
    const shown = SOURCES.filter((x) => !s.hidden[x.id]);
    const totals = Array.from({ length: N }, (_, i) => shown.reduce((a, x) => a + out[x.id][i], 0));
    const max = niceMax(Math.max(...totals) * 1.08);
    let base = Array(N).fill(0);
    const bands = SOURCES.map((x) => {
      const on = !s.hidden[x.id];
      const top = base.map((b, i) => b + (on ? out[x.id][i] : 0));
      const d = band(toPts(top, W, H, max, 6), toPts(base, W, H, max, 6));
      base = top;
      return { gid: 'g' + x.id, color: x.color, fill: `url(#g${x.id})`, cls: 'ar' + (s.first ? ' fadein' : ''), d: `d:path('${d}');opacity:${on ? 1 : 0}` };
    }).reverse();
    const prevTot = Array.from({ length: N }, (_, i) => SOURCES.filter((x) => !s.hidden[x.id]).reduce((a, x) => a + prevS.out[x.id][i] * 0.9, 0));
    const per = s.range === '12m' ? 'month' : s.range === 'quarter' ? 'week' : s.range === 'today' ? 'hour' : 'day';
    const hi = s.hi;
    const step = (W - 12) / (N - 1);
    const fmtDay = (i) => {
      if (s.range === 'today') { const hr = Math.round((i * 23) / (N - 1)); return `${hr % 12 || 12}:00 ${hr < 12 ? 'am' : 'pm'}`; }
      if (s.range === '12m') return ['Nov', 'Dec', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct'][Math.min(11, Math.floor((i * 12) / N))];
      const d = new Date(Date.UTC(2026, 9, 3) - Math.round(((N - 1 - i) * (R.days - 1)) / (N - 1)) * 86400000);
      return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'UTC' });
    };
    const goalRev = 6200000, goalPctV = Math.min(1, (cur.revenue / Math.max(1, R.days / 30)) / goalRev * 0.92);
    const funnelN = [cur.leads, Math.round(cur.leads * cur.contacted), Math.round(cur.leads * cur.reply), cur.booked, Math.round(cur.booked * 0.62), cur.won];
    const FN = ['New', 'Contacted', 'Replied', 'Call booked', 'Proposal', 'Won'];
    const titles = { leads: 'New leads', contacted: 'Contacted leads', reply: 'Leads who replied', booked: 'Calls booked', held: 'Calls held', revenue: `Revenue won · ${inr(cur.revenue)}`, won: `Won · ${fmt(cur.won)} leads`, winRate: 'Won, out of every lead', deal: 'Won deals, by value', speed: 'First contact, slowest first', overdue: `Follow-ups overdue · ${cur.overdue}`, forecast: 'Open leads, by forecast value', stuck: 'Stuck past their stage’s time', unassigned: 'Nobody yet', country: 'Numbers that need a country' };
    const dCount = { leads: cur.leads, revenue: cur.won, won: cur.won, overdue: cur.overdue, booked: cur.booked, held: cur.held }[s.drill] ?? 214;
    return {
      ...themeVals(this), ...rangeVals(this), filterN: '0',
      headline: s.slow ? 'A quieter month. Follow-ups are slipping.' : 'A strong month. Replies are up.',
      subline: s.slow ? 'New leads are down, and more follow-ups are overdue than last month. Two of your reps account for most of them.' : `${fmt(cur.leads)} new leads ${R.words.toLowerCase()}, and more of them are replying than the period before.`,
      kpis, cardCls: 'ac' + (s.first ? ' in' : ''),
      seriesSub: `Per ${per} · ${cmp ? 'dashed: the period before' : 'compare is off'}`,
      legend: SOURCES.map((x) => ({ label: x.label, sw: `background:${x.color}`, cls: s.hidden[x.id] ? 'dim' : '', toggle: () => this.setState({ hidden: { ...s.hidden, [x.id]: !s.hidden[x.id] }, first: false }) })),
      bands,
      gridY: [0, 0.25, 0.5, 0.75].map((f) => { const y = 6 + f * (H - 12); return { y: y.toFixed(1), ty: (y - 4).toFixed(1), label: fmt(max * (1 - f)) }; }),
      prevCls: 'prev', prevD: `d:path('${smooth(toPts(prevTot, W, H, max, 6))}');opacity:${cmp ? 0.55 : 0}`,
      xlabels: [0, 7, 15, 22, 29].map((i) => ({ x: (6 + i * step).toFixed(1), label: fmtDay(i).replace(/^(\w{3})\w*/, '$1') })),
      hx: hi == null ? -10 : (6 + hi * step).toFixed(1),
      hover: (e) => { const r = e.currentTarget.getBoundingClientRect(); const i = Math.max(0, Math.min(N - 1, Math.round(((e.clientX - r.left) / r.width) * (N - 1)))); if (i !== s.hi) this.setState({ hi: i }); },
      unhover: () => this.setState({ hi: null }), drillDay: () => this.setState({ drill: 'leads' }),
      tipCls: 'ctip' + (hi == null ? '' : ' on'), tipPos: `left:${hi == null ? 0 : Math.min(470, Math.max(0, (hi / (N - 1)) * 640 - 84))}px;top:12px`,
      tipTitle: hi == null ? '' : fmtDay(hi) + (per !== 'day' ? ` (a ${per})` : ''),
      tipRows: SOURCES.filter((x) => !s.hidden[x.id]).map((x) => ({ label: x.label, sw: `background:${x.color}`, v: hi == null ? '' : fmt(out[x.id][hi]) })),
      tipTotal: hi == null ? '' : fmt(totals[hi]),
      rangeLower: R.words.toLowerCase().replace(/^last/, 'in the last'),
      funnel: FN.map((name, i) => ({ name, n: fmt(funnelN[i]), pc: pctS(funnelN[i] / funnelN[0], i === 5 ? 1 : 0), w: `width:${Math.max(4, (funnelN[i] / funnelN[0]) * 100)}%`, barCls: 'bar' + (name === 'Won' ? ' won' : '') + (s.first ? ' in' : ''), hasDrop: i < 5, drop: i < 5 ? `${fmt(funnelN[i] - funnelN[i + 1])} stopped here · ${MINUS}${pctS(1 - funnelN[i + 1] / funnelN[i])}` : '', drill: drill('leads') })).map((f, i) => ({ ...f, i })),
      needs: [
        { ic: 'ic red', iClock: true, title: 'Follow-ups overdue', sub: s.slow ? 'Mostly Dev’s and Leo’s' : 'Oldest: 3 days, Kenji Sato', num: String(cur.overdue), drill: drill('overdue') },
        { ic: 'ic amber', iStuck: true, title: 'Stuck in a stage', sub: 'Past the time their stage allows', num: s.slow ? '67' : '38', drill: drill('stuck') },
        { ic: 'ic blue', iUser: true, title: 'Nobody yet', sub: 'Leads without an owner', num: s.slow ? '19' : '6', drill: drill('unassigned') },
        { ic: 'ic grey', iPhone: true, title: 'Numbers need a country', sub: 'LUME couldn’t read them', num: '12', drill: drill('country') },
      ],
      insights: s.slow
        ? [{ title: 'Follow-ups slipped after the 18th', body: 'Overdue follow-ups doubled in the last two weeks. Most belong to two people: worth a word.' }, { title: 'Webinar leads still convert best', body: '9.4% of webinar leads were won, against 4.9% overall. The next webinar is your best lever.' }, { title: 'Replies are slower on weekends', body: 'Leads messaged on Saturday reply 40% less. Weekday mornings work best.' }]
        : [{ title: 'Speed pays off', body: 'Leads contacted within an hour were won 2.3 times as often. Your median first contact is 14 minutes.' }, { title: 'Webinars punch above their weight', body: 'They bring 9% of leads and 21% of revenue won.' }, { title: 'Tuesday mornings get the most replies', body: 'Between 10 and 12, 52% of messages got an answer.' }],
      ringDash: `stroke-dashoffset:${333 - 333 * goalPctV}`, goalPct: pctS(goalPctV),
      goals: [
        { label: 'Won', text: `${s.slow ? 31 : 44} of 60`, w: `transform:scaleX(${s.slow ? 0.52 : 0.73})`, cls: 'gb' },
        { label: 'Calls held', text: `${s.slow ? 212 : 268} of 300`, w: `transform:scaleX(${s.slow ? 0.71 : 0.89})`, cls: 'gb' },
        { label: 'Follow-ups on time', text: s.slow ? '78% of 90%' : '93% of 90%', w: `transform:scaleX(${s.slow ? 0.87 : 1})`, cls: s.slow ? 'gb' : 'gb ok2' },
      ],
      dscrimCls: 'dscrim' + (s.drill ? ' on' : ''), dsheetCls: 'dsheet' + (s.drill ? ' on' : ''),
      closeDrill: () => this.setState({ drill: null }),
      dTitle: titles[s.drill] || 'The leads', dCount: fmt(dCount),
      dFacts: [R.words, 'All pipelines', 'Everyone’s leads', `${fmt(dCount)} leads`],
      dRows: PEOPLE.map((p, i) => ({ i: `--i:${i}`, ini: p[0].split(' ').map((w) => w[0]).join(''), name: p[0], sub: `${p[2]} · won ${['today', 'yesterday', 'Oct 1', 'Sep 30', 'Sep 29', 'Sep 28'][i % 6]}`, stage: p[1], dot: `background:${STAGE_C[p[1]]}`, val: inr(p[3]) })),
    };
  }
}

module.exports={Component};
