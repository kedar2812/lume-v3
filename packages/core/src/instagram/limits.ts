/**
 * What Instagram's Send API takes (Meta's pages, read 2026-11-22). The text limit is in UTF-8 bytes, not characters:
 * 1,000 bytes is 1,000 Latin letters, 333 Devanagari letters or 250 emoji. Checked when a flow is saved, when a person
 * sends, and again just before Meta.
 */
export const IG_LIMITS = {
  textBytes: 1000,
  quickReplies: 13,
  quickReplyChars: 20,
  genericCards: 10,
  cardTitleChars: 80,
  buttons: 3,
  buttonTextChars: 640,
} as const;

export type IgOutMessage = {
  text: string | null;
  mediaUrl?: string | null;
  mediaKind?: "image" | "video" | "audio" | "file";
  quickReplies?: { title: string; payload: string }[];
  buttons?: { title: string; url: string }[];
};

const encoder = new TextEncoder();
export const textBytes = (s: string): number => encoder.encode(s).length;
/** Characters as a person counts them (an emoji is one). */
const chars = (s: string) => [...s].length;
const blank = (s: string | null | undefined) => !s || !s.trim();

/** Every reason Instagram would refuse this message, in words; empty when it's fine. */
export function messageProblems(m: IgOutMessage): string[] {
  const out: string[] = [];
  const hasMedia = !!m.mediaUrl;
  if (blank(m.text) && !hasMedia) return ["Write a message or add a file."];
  const qr = m.quickReplies ?? [];
  const buttons = m.buttons ?? [];
  if (qr.length && buttons.length) return ["Use quick replies or buttons in one message, not both."];
  if (m.text && textBytes(m.text) > IG_LIMITS.textBytes)
    out.push(
      `This message is too long for Instagram: ${textBytes(m.text)} of ${IG_LIMITS.textBytes} bytes. Make it shorter.`,
    );
  if (qr.length) {
    if (blank(m.text)) out.push("Quick replies go with words. Write a message too.");
    if (qr.length > IG_LIMITS.quickReplies)
      out.push(`Instagram allows at most ${IG_LIMITS.quickReplies} quick replies.`);
    if (qr.some((q) => blank(q.title))) out.push("A quick reply needs words.");
    else if (qr.some((q) => chars(q.title) > IG_LIMITS.quickReplyChars))
      out.push(`A quick reply can be at most ${IG_LIMITS.quickReplyChars} characters.`);
    const seen = new Set(qr.map((q) => q.title.trim().toLowerCase()));
    if (seen.size < qr.length && !qr.some((q) => blank(q.title)))
      out.push("Two quick replies say the same thing.");
  }
  if (buttons.length) {
    if (blank(m.text)) out.push("Buttons go with words. Write a message too.");
    if (buttons.length > IG_LIMITS.buttons)
      out.push(`Instagram allows at most ${IG_LIMITS.buttons} buttons.`);
    if (m.text && chars(m.text) > IG_LIMITS.buttonTextChars)
      out.push(`With buttons, the message can be at most ${IG_LIMITS.buttonTextChars} characters.`);
    if (buttons.some((b) => blank(b.title))) out.push("A button needs words.");
    if (buttons.some((b) => !/^https:\/\/[^\s]+$/i.test(b.url)))
      out.push("A button's link must start with https://.");
  }
  return out;
}
