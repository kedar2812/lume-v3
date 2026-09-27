// Spec §6.7–§6.12: reading one cell the way people type it. Each parser either returns a value (maybe with a
// warning) or the one reason the value can't be used — never a guess the admin can't see.

export type DateOrder = "DMY" | "MDY" | "YMD";
export type ValueIssue = { code: string; message: string };
export type Parsed<T> = { ok: true; value: T; warning?: ValueIssue } | { ok: false; issue: ValueIssue };

const okv = <T>(value: T, warning?: ValueIssue): Parsed<T> =>
  warning ? { ok: true, value, warning } : { ok: true, value };
const bad = (code: string, message: string): Parsed<never> => ({ ok: false, issue: { code, message } });

/** Lower-case, accents removed, spaces collapsed — for matching labels. */
export const fold = (s: string): string =>
  s.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/\s+/g, " ").trim();

// ── dates ─────────────────────────────────────────────────────────────────────
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const NUMERIC = /^(\d{1,4})[/.-](\d{1,2})[/.-](\d{2,4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/;
const ISO = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;
const MDY_COUNTRIES = new Set(["US", "PH", "BZ", "FM", "MH", "PW"]);

export const defaultDateOrder = (country: string | null): DateOrder =>
  country && MDY_COUNTRIES.has(country) ? "MDY" : "DMY";

/** Spec §6.7: any first part over 12 means DMY, any second part over 12 means MDY; both is a conflict. */
export function detectDateOrder(values: string[]): DateOrder | "conflict" | "ambiguous" {
  let dmy = false;
  let mdy = false;
  let ymd = false;
  for (const raw of values) {
    const v = raw.trim();
    if (!v) continue;
    if (ISO.test(v)) {
      ymd = true;
      continue;
    }
    const m = NUMERIC.exec(v);
    if (!m) continue;
    if (m[1]!.length === 4) {
      ymd = true;
      continue;
    }
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (a > 12 && a <= 31) dmy = true;
    if (b > 12 && b <= 31) mdy = true;
  }
  if (dmy && mdy) return "conflict";
  if (dmy) return "DMY";
  if (mdy) return "MDY";
  if (ymd) return "YMD";
  return "ambiguous";
}

const pad = (n: number) => String(n).padStart(2, "0");
const validYmd = (y: number, m: number, d: number) =>
  m >= 1 && m <= 12 && d >= 1 && d <= new Date(Date.UTC(y, m, 0)).getUTCDate();
/** A two-digit year is this century up to next year, else the last one ("99" → 1999). */
const fullYear = (y: number, today: string) => {
  if (y >= 100) return y;
  const yy = Number(today.slice(2, 4));
  return y <= yy + 1 ? 2000 + y : 1900 + y;
};

/** Minutes east of UTC for `tz` at the instant `utcMs`. */
function offsetMinutes(utcMs: number, tz: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
      .formatToParts(new Date(utcMs))
      .map((p) => [p.type, p.value]),
  );
  const asUtc = Date.UTC(
    +parts.year!,
    +parts.month! - 1,
    +parts.day!,
    +parts.hour!,
    +parts.minute!,
    +parts.second!,
  );
  return Math.round((asUtc - utcMs) / 60_000);
}

/** A wall-clock time in `tz` → the UTC instant (two passes settle DST edges). */
function zonedToUtc(y: number, mo: number, d: number, h: number, mi: number, s: number, tz: string): number {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  const first = guess - offsetMinutes(guess, tz) * 60_000;
  return guess - offsetMinutes(first, tz) * 60_000;
}

/** Midnight at the start of `date` (YYYY-MM-DD) in `tz`, as an instant. */
export function startOfDayUtc(date: string, tz: string): Date {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new Date(zonedToUtc(y, m, d, 0, 0, 0, tz));
}

/** The calendar date of an instant in `tz`. */
const dateIn = (utcMs: number, tz: string): string =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(utcMs));

type DateCtx = { today: string; timezone: string };
type Time = [number, number, number];

function finish(
  y: number,
  m: number,
  d: number,
  time: Time | null,
  offset: string | null,
  ctx: DateCtx,
): Parsed<{ date: string; instant: string }> {
  if (!validYmd(y, m, d)) return bad("DATE_IMPOSSIBLE", "This date doesn't exist.");
  const [h, mi, s] = time ?? [0, 0, 0];
  if (h > 23 || mi > 59 || s > 59) return bad("DATE_IMPOSSIBLE", "This time doesn't exist.");
  let instant: number;
  if (offset) {
    const sign = offset === "Z" ? 0 : offset.startsWith("-") ? -1 : 1;
    const [oh, om] = offset === "Z" ? [0, 0] : [Number(offset.slice(1, 3)), Number(offset.slice(-2))];
    instant = Date.UTC(y, m - 1, d, h, mi, s) - sign * (oh * 60 + om) * 60_000;
  } else instant = zonedToUtc(y, m, d, h, mi, s, ctx.timezone);
  // A written offset pins the instant, so its business-day date can differ from the digits typed.
  const date = offset ? dateIn(instant, ctx.timezone) : `${y}-${pad(m)}-${pad(d)}`;
  if (date > ctx.today) return bad("DATE_FUTURE", "Date is in the future — check the day/month order.");
  if (date < "1990-01-01") return bad("DATE_TOO_OLD", "Date looks wrong (before 1990).");
  return okv({ date, instant: new Date(instant).toISOString() });
}

const timeOf = (h?: string, mi?: string, s?: string): Time | null =>
  h ? [Number(h), Number(mi), Number(s ?? 0)] : null;

/** Spec §6.7: ISO, numeric in the column's order, an Excel serial, or "4 Mar 2026" / "March 4, 2026". */
export function parseDate(
  raw: string,
  order: DateOrder,
  ctx: DateCtx,
): Parsed<{ date: string; instant: string }> {
  const v = raw.trim();
  const iso = ISO.exec(v);
  if (iso) return finish(+iso[1]!, +iso[2]!, +iso[3]!, timeOf(iso[4], iso[5], iso[6]), iso[7] ?? null, ctx);

  if (/^\d{5}(\.\d+)?$/.test(v)) {
    const serial = Number(v);
    if (serial < 20000 || serial > 80000) return bad("DATE_UNREADABLE", "LUME can't read this as a date.");
    const dt = new Date(Date.UTC(1899, 11, 30) + Math.round(serial * 86_400_000));
    const time: Time | null = serial % 1 ? [dt.getUTCHours(), dt.getUTCMinutes(), dt.getUTCSeconds()] : null;
    return finish(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate(), time, null, ctx);
  }

  const n = NUMERIC.exec(v);
  if (n) {
    const [a, b, c] = [Number(n[1]), Number(n[2]), Number(n[3])];
    const t = timeOf(n[4], n[5], n[6]);
    if (n[1]!.length === 4) return finish(a, b, c, t, null, ctx);
    const y = fullYear(c, ctx.today);
    return order === "MDY" ? finish(y, a, b, t, null, ctx) : finish(y, b, a, t, null, ctx);
  }

  const words = /^(\d{1,2})\s+([a-z]+)\.?,?\s+(\d{2,4})$/i.exec(v);
  const wordsUs = /^([a-z]+)\.?\s+(\d{1,2}),?\s+(\d{2,4})$/i.exec(v);
  const pick = words
    ? { d: Number(words[1]), mon: words[2]!, y: Number(words[3]) }
    : wordsUs
      ? { d: Number(wordsUs[2]), mon: wordsUs[1]!, y: Number(wordsUs[3]) }
      : null;
  if (pick) {
    const m = MONTHS.indexOf(pick.mon.slice(0, 3).toLowerCase()) + 1;
    if (m > 0) return finish(fullYear(pick.y, ctx.today), m, pick.d, null, null, ctx);
  }
  return bad("DATE_UNREADABLE", "LUME can't read this as a date.");
}

// ── numbers and money ─────────────────────────────────────────────────────────
const COMMA_DECIMAL = new Set([
  "DE", "FR", "ES", "IT", "NL", "BE", "PT", "BR", "AR", "CL", "CO", "ID", "TR", "RU", "UA",
  "PL", "SE", "NO", "DK", "FI", "AT", "CZ", "GR", "RO", "HU", "VN", "ZA",
]); // prettier-ignore
export const defaultDecimalMark = (country: string | null): "." | "," =>
  country && COMMA_DECIMAL.has(country) ? "," : ".";

// Spaces (\s includes no-break and thin ones) and apostrophes only ever group thousands.
const strip = (s: string) => s.replace(/[\s']/g, "");

/** What one value says about its decimal mark, if anything. */
function markOf(raw: string): "." | "," | null {
  const s = strip(raw).replace(/^[^\d-]+|[^\d%]+$/g, "");
  const dots = (s.match(/\./g) ?? []).length;
  const commas = (s.match(/,/g) ?? []).length;
  if (dots && commas) return s.lastIndexOf(".") > s.lastIndexOf(",") ? "." : ",";
  if (dots > 1) return ",";
  if (commas > 1) return ".";
  const one = dots ? "." : commas ? "," : null;
  if (!one) return null;
  const after = s.length - s.lastIndexOf(one) - 1;
  return after === 3 ? null : one; // exactly three digits after one separator: can't tell
}

/** Spec §6.8: the column decides; values that can't tell follow the business's convention. */
export function detectDecimalMark(values: string[], fallback: "." | ","): "." | "," {
  let dot = 0;
  let comma = 0;
  for (const v of values) {
    const m = markOf(v);
    if (m === ".") dot++;
    if (m === ",") comma++;
  }
  if (!dot && !comma) return fallback;
  return comma > dot ? "," : ".";
}

export function parseNumber(raw: string, decimal: "." | ","): Parsed<number> {
  const notOne = bad("NOT_A_NUMBER", `“${raw.trim()}” isn't a number.`);
  const s = strip(raw).replace(/%$/, "");
  const thousands = decimal === "." ? "," : ".";
  if (!/^-?[\d.,]+$/.test(s)) return notOne;
  const [int, frac, ...more] = s.split(decimal);
  if (more.length) return notOne;
  const groups = int!.replace(/^-/, "").split(thousands);
  // Western groups of three, or Indian lakh grouping (2s then a final 3): 1,20,000.
  const western = groups.slice(1).every((g) => g.length === 3);
  const indian =
    groups.length > 2 && groups.slice(1, -1).every((g) => g.length === 2) && groups.at(-1)!.length === 3;
  if (groups.length > 1 && (!(western || indian) || !groups[0])) return notOne;
  const n = Number(`${int!.replaceAll(thousands, "")}${frac !== undefined ? `.${frac}` : ""}`);
  return Number.isFinite(n) ? okv(n) : notOne;
}

const SYMBOLS: Record<string, string> = {
  $: "USD",
  "€": "EUR",
  "£": "GBP",
  "₹": "INR",
  "¥": "JPY",
  "₩": "KRW",
  "₽": "RUB",
  "₺": "TRY",
  "₦": "NGN",
  "₱": "PHP",
  "د.إ": "AED",
  "ر.س": "SAR",
  "﷼": "SAR",
};
const CURRENCY_CODES: ReadonlySet<string> = new Set(
  typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("currency") : Object.values(SYMBOLS),
);

/** The most a lead's value can hold (numeric(14, 2)), the same ceiling the lead form has. */
const MAX_AMOUNT = 999_999_999_999.99;

/** Half-up to cents from the decimal digits (10.005 → 10.01), not from the float's binary approximation. */
const toCents = (v: number): number => {
  const [m, e = "0"] = String(v).split("e");
  return Number(`${Math.round(Number(`${m}e${Number(e) + 2}`))}e${Number(e) - 2}`);
};

/** Spec §6.8: an amount in the business currency, with its code or symbol before or after. */
export function parseMoney(raw: string, decimal: "." | ",", currency: string): Parsed<number> {
  let s = raw.trim();
  let found: string | null = null;
  for (const [sym, code] of Object.entries(SYMBOLS))
    if (s.includes(sym)) {
      found = code;
      s = s.replace(sym, "");
    }
  const codeMatch = /\b([A-Za-z]{3})\b/.exec(s);
  if (codeMatch && CURRENCY_CODES.has(codeMatch[1]!.toUpperCase())) {
    found = codeMatch[1]!.toUpperCase();
    s = s.replace(codeMatch[0], "");
  }
  if (found && found !== currency)
    return bad(
      "FOREIGN_CURRENCY",
      `This amount is in ${found}; LUME works in ${currency} — convert it before importing.`,
    );
  const n = parseNumber(s, decimal);
  if (!n.ok) return n;
  if (n.value < 0) return bad("NEGATIVE_AMOUNT", "An amount can't be negative.");
  if (n.value > MAX_AMOUNT)
    return bad(
      "AMOUNT_TOO_LARGE",
      "This amount is too large (the most a lead can hold is 999,999,999,999.99).",
    );
  const rounded = toCents(n.value);
  return rounded === n.value
    ? okv(rounded)
    : okv(rounded, { code: "AMOUNT_ROUNDED", message: `Rounded ${n.value} to ${rounded}.` });
}

// ── booleans, contacts, links ─────────────────────────────────────────────────
const YES = new Set(["yes", "y", "true", "1", "✓", "✔", "x"]);
const NO = new Set(["no", "n", "false", "0", "✗", "✘"]);
export function parseBoolean(raw: string): boolean | null {
  const v = fold(raw);
  if (YES.has(v)) return true;
  if (NO.has(v)) return false;
  return null;
}

export function readEmail(raw: string): string | null {
  const v = raw
    .trim()
    .replace(/^mailto:/i, "")
    .toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v) && v.length <= 254 ? v : null;
}

export function readInstagram(raw: string): string | null {
  let v = raw.trim();
  const url = /^(?:https?:\/\/)?(?:www\.)?instagram\.com\/([^/?#]+)/i.exec(v);
  if (url) v = url[1]!;
  v = v.replace(/^@/, "");
  return /^[A-Za-z0-9._]{1,30}$/.test(v) ? v.toLowerCase() : null;
}

/** A web link, with https:// added when it was left off. */
export function readUrl(raw: string): string | null {
  const v = raw.trim();
  if (!v || /\s/.test(v)) return null;
  try {
    const u = new URL(/^https?:\/\//i.test(v) ? v : `https://${v}`);
    if (!u.hostname.includes(".")) return null;
    const s = u.toString();
    return s.endsWith("/") && !v.endsWith("/") ? s.slice(0, -1) : s;
  } catch {
    return null;
  }
}

/** Several numbers typed into one cell: "050 111 2222 / 055 333 4444", "… or …", commas, semicolons. */
export const splitPhones = (raw: string): string[] =>
  raw
    .split(/\s*(?:\/|,|;|\bor\b)\s*/i)
    .map((p) => p.trim())
    .filter(Boolean);

/** Excel's scientific notation (9.71501E+11), which has already lost a phone number's last digits. */
export const isScientific = (raw: string): boolean => /^\d+([.,]\d+)?e\+?\d+$/i.test(raw.trim());
