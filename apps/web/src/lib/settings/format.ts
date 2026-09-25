const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "22 Sep 2026" (or "22 Sep"), spelled the same on every runtime; ICU's en-GB says "Sept". */
export function shortDate(iso: string, withYear = true): string {
  const d = new Date(iso);
  return `${d.getDate()} ${MONTHS[d.getMonth()]}${withYear ? ` ${d.getFullYear()}` : ""}`;
}

/** "22 Sep, 14:05": a moment in the viewer's own clock. */
export function shortDateTime(iso: string): string {
  const d = new Date(iso);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${shortDate(iso, false)}, ${hh}:${mm}`;
}
