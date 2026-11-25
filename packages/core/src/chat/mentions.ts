/**
 * A message's words as people read them (plan 2026-11-25-team-chat-2b, Task 2): names mentioned, and a little Markdown.
 * Pure and browser-safe: the server decides who is told from the very words the screen draws.
 */
export type Part =
  | { t: "text" | "bold" | "italic" | "code"; s: string }
  | { t: "link"; s: string; href: string }
  | { t: "person"; id: string }
  | { t: "team"; id: string }
  | { t: "channel" };

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
// Code first: nothing inside it means anything else. Emphasis hugs its words, on one line, and sits at a word's edge,
// so snake_case names and sums like 2*3*4 stay as typed. A name is never lost inside it: such marks stay as typed too.
const TOKEN = new RegExp(
  [
    "`(?<code>[^`\n]+)`",
    `<@(?<person>${UUID})>`,
    `<@team:(?<team>${UUID})>`,
    "(?<channel><@channel>)",
    String.raw`(?<link>https?://[^\s<>"']+)`,
    String.raw`(?<![\p{L}\p{M}\p{N}*])\*(?<bold>(?!<@)[^\s*](?:(?:(?!<@)[^*\n])*[^\s*])?)\*(?![\p{L}\p{M}\p{N}*])`,
    String.raw`(?<![\p{L}\p{M}\p{N}_])_(?<italic>(?!<@)[^\s_](?:(?:(?!<@)[^_\n])*[^\s_])?)_(?![\p{L}\p{M}\p{N}_])`,
  ].join("|"),
  "gu",
);

/** A link ends before the sentence's own punctuation, and before a bracket it didn't open. */
function trimLink(url: string): string {
  const count = (c: string) => url.split(c).length - 1;
  let extra = count(")") - count("(");
  let end = url.length;
  for (; end > 0; end--) {
    const c = url[end - 1]!;
    if (c === ")" && extra > 0) extra--;
    else if (!".,;:!?".includes(c)) break;
  }
  return url.slice(0, end);
}

export function partsOf(body: string): Part[] {
  const out: Part[] = [];
  let at = 0;
  const text = (s: string) => {
    if (!s) return;
    const last = out.at(-1);
    if (last?.t === "text") last.s += s;
    else out.push({ t: "text", s });
  };
  TOKEN.lastIndex = 0;
  for (let m = TOKEN.exec(body); m; m = TOKEN.exec(body)) {
    const g = m.groups!;
    text(body.slice(at, m.index));
    at = m.index + m[0].length;
    if (g.code !== undefined) out.push({ t: "code", s: g.code });
    else if (g.person) out.push({ t: "person", id: g.person });
    else if (g.team) out.push({ t: "team", id: g.team });
    else if (g.channel) out.push({ t: "channel" });
    else if (g.bold !== undefined) out.push({ t: "bold", s: g.bold });
    else if (g.italic !== undefined) out.push({ t: "italic", s: g.italic });
    else {
      const href = trimLink(g.link!);
      if (URL.canParse(href)) out.push({ t: "link", s: href, href });
      else text(href);
      at = TOKEN.lastIndex = m.index + href.length;
    }
  }
  text(body.slice(at));
  return out;
}

/** Whom a message names, each once. */
export function mentionsOf(body: string): { people: string[]; teams: string[]; channel: boolean } {
  const parts = partsOf(body);
  const ids = (t: "person" | "team") => [
    ...new Set(parts.filter((p): p is { t: "person" | "team"; id: string } => p.t === t).map((p) => p.id)),
  ];
  return { people: ids("person"), teams: ids("team"), channel: parts.some((p) => p.t === "channel") };
}

/** The words alone, for a notice or a quote: names where the reader knows them, no marks. */
export const plainOf = (body: string, name: (t: "person" | "team", id: string) => string | null): string =>
  partsOf(body)
    .map((p) =>
      p.t === "channel"
        ? "@channel"
        : p.t === "person" || p.t === "team"
          ? `@${name(p.t, p.id) ?? (p.t === "team" ? "a team" : "someone")}`
          : p.s,
    )
    .join("");

/** Someone chosen while writing: as the box shows them (`@Maya Kapoor`), and as the message keeps them. */
export type Picked = { label: string; token: string };
export const personToken = (id: string): string => `<@${id}>`;
export const teamToken = (id: string): string => `<@team:${id}>`;
export const CHANNEL_TOKEN = "<@channel>";

const edge = (c: string | undefined) => c === undefined || !/[\p{L}\p{M}\p{N}]/u.test(c);
/**
 * Where a name chosen stands in the box's words: outside code, where nothing means anything but itself. `whole`: only
 * at a word's edges (a name being written right beside another doesn't undo it meanwhile).
 */
function labelsIn(text: string, labels: string[], whole = true): { at: number; label: string }[] {
  const long = [...new Set(labels)].sort((a, b) => b.length - a.length);
  const out: { at: number; label: string }[] = [];
  for (let i = 0; i < text.length;) {
    if (text[i] === "`") {
      const code = /^`[^`\n]+`/.exec(text.slice(i, i + 4100))?.[0];
      i += code?.length ?? 1;
      continue;
    }
    const label =
      text[i] === "@" && (!whole || edge(text[i - 1]))
        ? long.find((l) => text.startsWith(l, i) && (!whole || edge(text[i + l.length])))
        : undefined;
    if (label === undefined) i++;
    else {
      out.push({ at: i, label });
      i += label.length;
    }
  }
  return out;
}

/**
 * The box's words as they are sent: each `@Name` that was chosen becomes whom it names, the longest name first (so
 * "@Maya Kapoor" is never "@Maya" and a surname), in the order chosen where two share a name. One typed and never
 * chosen stays words; one chosen and then taken out names nobody.
 */
export function encodeMentions(text: string, picked: Picked[]): string {
  const by = new Map<string, string[]>();
  for (const p of picked) by.set(p.label, [...(by.get(p.label) ?? []), p.token]);
  const used = new Map<string, number>();
  let out = "";
  let from = 0;
  for (const { at, label } of labelsIn(text, [...by.keys()])) {
    const tokens = by.get(label)!;
    const n = used.get(label) ?? 0;
    used.set(label, n + 1);
    out += text.slice(from, at) + tokens[Math.min(n, tokens.length - 1)]!;
    from = at + label.length;
  }
  return out + text.slice(from);
}

/**
 * Whoever is still chosen once the words have changed, the caret now at `caret`: where two share a name, the one whose
 * place went is gone.
 */
export function keepPicked(before: string, after: string, caret: number, picked: Picked[]): Picked[] {
  if (!picked.length) return picked;
  let same = 0;
  while (same < Math.min(before.length, caret) && before[same] === after[same]) same++;
  const labels = picked.map((p) => p.label);
  const left = labelsIn(after, labels, false);
  return [...new Set(labels)].flatMap((label) => {
    const mine = picked.filter((p) => p.label === label);
    const gone = mine.length - left.filter((l) => l.label === label).length;
    if (gone <= 0) return mine;
    // Those wholly before the change stand; the ones gone come right after them.
    const stand = labelsIn(before, labels, false).filter(
      (l) => l.label === label && l.at + label.length <= same,
    ).length;
    return [...mine.slice(0, stand), ...mine.slice(stand + gone)];
  });
}

/** A message as the box shows it for changing: names for tokens, and whom each is. */
export function decodeMentions(
  body: string,
  name: (t: "person" | "team", id: string) => string | null,
): { text: string; picked: Picked[] } {
  const picked: Picked[] = [];
  const token = new RegExp("`[^`\n]+`" + `|<@(?:(team:)?(${UUID})|(channel))>`, "g");
  const text = body.replace(token, (whole, team: string | undefined, id: string | undefined) => {
    if (whole.startsWith("`")) return whole;
    const label = id ? `@${name(team ? "team" : "person", id) ?? (team ? "a team" : "someone")}` : "@channel";
    picked.push({ label, token: whole });
    return label;
  });
  return { text, picked };
}
