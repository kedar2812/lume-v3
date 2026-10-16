/** Feedback's words and colours on the panel (spec 2026-10-16 §3; canvas 4F4RK4iLdxsMPXcBEvZhyY). No violet. */
export type Kind = "bug" | "idea" | "confusing";
export type FeedbackStatus = "new" | "seen" | "fixing" | "fixed" | "not_a_bug";

export const KIND_WORDS: Record<Kind, string> = {
  bug: "Something's broken",
  idea: "An idea",
  confusing: "Something's confusing",
};
/** The same dots the clients list uses: red, LUME's blue, amber. */
export const KIND_COLOR: Record<Kind, string> = { bug: "#e5484d", idea: "#2a5bff", confusing: "#f2a20c" };
export const STATUS_WORDS: Record<FeedbackStatus, string> = {
  new: "New",
  seen: "Seen",
  fixing: "Fixing",
  fixed: "Fixed",
  not_a_bug: "Not a bug",
};
export const statusText = (s: FeedbackStatus, fixedIn: string | null) =>
  s === "fixed" && fixedIn ? `Fixed in ${fixedIn}` : STATUS_WORDS[s];

const parts = (v: string) => v.split(".").map(Number);
/** The client's LUME is older than the latest release. */
export function isBehind(version: string | null, latest: string | null): boolean {
  if (!version || !latest) return false;
  const [a, b] = [parts(version), parts(latest)];
  for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) < (b[i] ?? 0);
  return false;
}

const SYSTEMS: [RegExp, string][] = [
  [/iPhone/, "iPhone"],
  [/iPad/, "iPad"],
  [/Android/, "Android"],
  [/Windows/, "Windows"],
  [/Mac OS X|Macintosh/, "macOS"],
  [/CrOS/, "ChromeOS"],
  [/Linux/, "Linux"],
];
/** "Chrome 141 on Windows", from a user agent; the string itself when it isn't one LUME knows. */
export function browserName(ua: string): string {
  const os = SYSTEMS.find(([re]) => re.test(ua))?.[1];
  const pick = (name: string, re: RegExp) => {
    const v = re.exec(ua)?.[1];
    return v ? `${name} ${v}` : null;
  };
  const browser =
    pick("Edge", /Edg\/(\d+)/) ??
    pick("Firefox", /Firefox\/(\d+)/) ??
    pick("Chrome", /Chrome\/(\d+)/) ??
    (/Safari/.test(ua) ? pick("Safari", /Version\/(\d+)/) : null);
  return browser && os ? `${browser} on ${os}` : ua;
}

type ForReport = {
  kind: Kind;
  firstLine: string;
  text: string;
  client: { name: string };
  reporter: { role: string };
  page: string;
  appVersion: string;
  browser: string;
  screen: string;
  theme: "porcelain" | "obsidian";
  receivedAt: string;
  imageCount: number;
};
/**
 * Copy as bug report (spec 2026-10-16 §3.3): Markdown for an issue or Claude Code. The words go in a fence longer than
 * any run of backticks inside them, so nothing they hold can end it early. The reporter's name and email stay out.
 */
export function bugReport(d: ForReport): string {
  const longest = Math.max(0, ...[...d.text.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  const shots = d.imageCount
    ? [`- ${d.imageCount} screenshot${d.imageCount === 1 ? "" : "s"} (download them from the dashboard)`]
    : [];
  return [
    `## ${KIND_WORDS[d.kind]}: ${d.firstLine}`,
    "",
    fence,
    d.text,
    fence,
    "",
    `- Client: ${d.client.name}`,
    `- Reporter: ${d.reporter.role}`,
    `- Page: \`${d.page}\``,
    `- LUME: ${d.appVersion}`,
    `- Browser: ${browserName(d.browser)}`,
    `- Screen: ${d.screen}`,
    `- Theme: ${d.theme === "obsidian" ? "Obsidian" : "Porcelain"}`,
    `- Received: ${d.receivedAt}`,
    ...shots,
    "",
  ].join("\n");
}
