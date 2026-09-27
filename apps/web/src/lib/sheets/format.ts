/** "just now", "2 min ago", "3 h ago", "2 days ago". */
export function ago(iso: string, now = Date.now()): string {
  const s = Math.max(0, (now - Date.parse(iso)) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)} h ago`;
  const d = Math.floor(s / 86_400);
  return d === 1 ? "yesterday" : `${d} days ago`;
}
/** "in a moment", "in 2 min", "in 1 h". Overdue reads as "in a moment": it's about to happen. */
export function inFuture(iso: string, now = Date.now()): string {
  const s = (Date.parse(iso) - now) / 1000;
  if (s < 60) return "in a moment";
  if (s < 3600) return `in ${Math.round(s / 60)} min`;
  return `in ${Math.round(s / 3600)} h`;
}
