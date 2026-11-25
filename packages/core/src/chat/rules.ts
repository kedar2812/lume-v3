/**
 * Team Chat's shared rules (spec 2026-11-24-team-chat-design; plan 2026-11-24-team-chat-2a, Task 2): pure, so the
 * server and the screen hold a message, a name and a count to the same limits. No Node built-ins: browser-safe.
 */
export const CHAT_LIMITS = {
  /** Characters in a message, as people count them (an emoji is one). */
  body: 4000,
  files: 10,
  /** People in a direct message, oneself included. */
  directPeople: 8,
  channelName: 80,
  topic: 250,
  page: 50,
  /** The browser says "typing" at most this often while keys are pressed. */
  typingEveryMs: 3000,
  /** Others show it this long after the last. */
  typingShowsMs: 5000,
  /** Online: a live stream open in this long. */
  onlineMs: 60_000,
  /** A run of bubbles breaks after this long without a message. */
  runGapMs: 5 * 60_000,
} as const;

const chars = (s: string) => [...s].length;

/** A message's words as kept: trimmed, with Windows line ends made plain. */
export const bodyOf = (text: string): string => text.replace(/\r\n?/g, "\n").trim();

/** Why a message can't go as written, or null. `hasFiles`: a photo or file may go with no words. */
export function bodyProblem(text: string, hasFiles: boolean): string | null {
  const b = bodyOf(text);
  if (!b) return hasFiles ? null : "Write a message or add a file.";
  if (chars(b) > CHAT_LIMITS.body) return "A message can be at most 4,000 characters.";
  return null;
}

/** Why a channel's name won't do, or null. */
export function channelNameProblem(name: string): string | null {
  if (!name) return "Name the channel.";
  if (chars(name) > CHAT_LIMITS.channelName) return "A channel's name can be at most 80 characters.";
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name))
    return "Use lower case letters, digits and dashes, like spring-batch.";
  return null;
}

/** Who is typing, in words: one, two, then several. */
export function typingWords(names: string[]): string {
  if (names.length === 0) return "";
  if (names.length === 1) return `${names[0]} is typing…`;
  if (names.length === 2) return `${names[0]} and ${names[1]} are typing…`;
  return "Several people are typing…";
}

/** A folded list's unread, as its heading says it: nothing at none, 99+ past 99. */
export function unreadSum(counts: number[]): string {
  const n = counts.reduce((t, c) => t + Math.max(0, c), 0);
  return n <= 0 ? "" : n > 99 ? "99+" : String(n);
}

const dayOf = (iso: string, timeZone: string) =>
  new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(
    new Date(iso),
  );

/**
 * Each message's side and whether it starts a run of bubbles (owner, 2026-11-24: mine on the right, others on the
 * left, each run on its sender's photo). A run breaks on another person, a new day in the business's time zone, or a
 * gap of more than 5 minutes. LUME's own messages (no author) are never "mine".
 */
export function runsOf<T extends { authorId: string | null; createdAt: string }>(
  msgs: T[],
  me: string,
  timeZone: string,
): (T & { side: "in" | "mine"; head: boolean })[] {
  let prev: T | null = null;
  return msgs.map((m) => {
    const head =
      !prev ||
      prev.authorId !== m.authorId ||
      dayOf(prev.createdAt, timeZone) !== dayOf(m.createdAt, timeZone) ||
      Date.parse(m.createdAt) - Date.parse(prev.createdAt) > CHAT_LIMITS.runGapMs;
    prev = m;
    return { ...m, side: m.authorId !== null && m.authorId === me ? "mine" : "in", head };
  });
}

/** A message's ticks: seen once everyone else has read it, delivered once everyone else's device has it. */
export function ticksOf(
  messageId: number,
  others: { lastDeliveredId: number; lastReadId: number }[],
): "sent" | "delivered" | "seen" {
  if (others.length === 0) return "sent";
  if (others.every((o) => o.lastReadId >= messageId)) return "seen";
  if (others.every((o) => Math.max(o.lastDeliveredId, o.lastReadId) >= messageId)) return "delivered";
  return "sent";
}
