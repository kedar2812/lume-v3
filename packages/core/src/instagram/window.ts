/**
 * Meta's messaging window for Instagram (NEW_FEATURES_PLAN §4.4; Meta's policy, read 2026-11-22). Pure UTC maths, so
 * the business's time zone never changes the answer.
 *
 * - open: within 24 hours of the person's last message, reaction or tap, or until 7 days after a first message from
 *   an ad click. Anyone may send: a flow, LUME AI or a person.
 * - human: after that, within 7 days of the person's last message. Only a person, with Meta's human agent tag.
 * - closed: nobody until the person writes again.
 */
export type IgWindow =
  { state: "open"; until: Date } | { state: "human"; until: Date } | { state: "closed"; since: Date | null };

export const IG_WINDOW_MS = 24 * 3_600_000;
export const IG_HUMAN_MS = 7 * 24 * 3_600_000;
export const IG_PRIVATE_REPLY_MS = 7 * 24 * 3_600_000;

export function instagramWindow(
  t: { lastInAt: Date | null; adWindowUntil: Date | null },
  now: Date,
): IgWindow {
  const n = now.getTime();
  // A last message stamped a little ahead of this server's clock is treated as now.
  const last = t.lastInAt ? Math.min(t.lastInAt.getTime(), n) : null;
  const open = Math.max(
    last === null ? -Infinity : last + IG_WINDOW_MS,
    t.adWindowUntil?.getTime() ?? -Infinity,
  );
  if (n < open) return { state: "open", until: new Date(open) };
  if (last === null)
    return {
      state: "closed",
      since: t.adWindowUntil && t.adWindowUntil.getTime() <= n ? t.adWindowUntil : null,
    };
  const human = last + IG_HUMAN_MS;
  if (n < human) return { state: "human", until: new Date(human) };
  return { state: "closed", since: new Date(human) };
}

/** One private reply to a comment, within 7 days of it: a failed one may be tried again while there's time. */
export function privateReplyOpen(
  c: { at: Date; privateReply: "none" | "queued" | "sent" | "failed" },
  now: Date,
): boolean {
  if (c.privateReply !== "none" && c.privateReply !== "failed") return false;
  return now.getTime() < c.at.getTime() + IG_PRIVATE_REPLY_MS;
}
