const ATTACHMENT: Record<string, string> = {
  image: "A photo",
  video: "A video",
  audio: "A voice message",
  file: "A file",
  share: "A shared post",
  story_mention: "Mentioned you in a story",
  ig_reel: "A reel",
  reel: "A reel",
};
/** What came with a message, in words: never Meta's links or ids. */
export function detailWords(d: Record<string, unknown>): string[] {
  const out: string[] = [];
  if (d.story) out.push("Replied to your story");
  if (d.mention) out.push("Mentioned you in a story");
  if (d.referral) out.push("Came from an ad");
  if (Array.isArray(d.attachments))
    for (const a of d.attachments) out.push(ATTACHMENT[String(a)] ?? "An attachment");
  return [...new Set(out)];
}
