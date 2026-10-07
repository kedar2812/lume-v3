/** Today's greeting for an hour (0–23) on the person's clock: a 1 am session is still "Good evening", not "morning". */
export function greetingAt(h: number): string {
  return h < 5 ? "Good evening" : h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
}
