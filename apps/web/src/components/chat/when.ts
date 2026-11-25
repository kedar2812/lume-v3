/** Days and times in chat, in the business's time zone. */
export const dayKey = (iso: string, zone: string) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(iso));
export function dayWords(iso: string, zone: string, now = new Date()): string {
  const k = dayKey(iso, zone);
  if (k === dayKey(now.toISOString(), zone)) return "Today";
  if (k === dayKey(new Date(now.getTime() - 86_400_000).toISOString(), zone)) return "Yesterday";
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: zone,
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(new Date(iso));
}
export const timeOf = (iso: string, zone: string) =>
  new Intl.DateTimeFormat("en-IN", { timeZone: zone, hour: "numeric", minute: "2-digit" }).format(
    new Date(iso),
  );
/** The last answer's time: today's as a time, an earlier day's as the day. */
export const lastWords = (iso: string, zone: string) => {
  const day = dayWords(iso, zone);
  return day === "Today" ? timeOf(iso, zone) : day;
};
