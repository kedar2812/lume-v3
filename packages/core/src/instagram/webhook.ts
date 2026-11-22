import { createHash } from "node:crypto";
import { z } from "zod";

/**
 * Meta's Instagram deliveries as LUME reads them (Instagram API with Instagram Login; NEW_FEATURES_PLAN §4.3): DMs and
 * their echoes, story replies and mentions, ad clicks, taps, reactions, reads, unsends and comments. Pure; never throws:
 * what it can't read is dropped, item by item, so one odd item never loses the rest of a batch.
 */
export type IgReferral = {
  source: string | null;
  type: string | null;
  adId: string | null;
  ref: string | null;
  adTitle: string | null;
};
export type IgAttachmentType =
  "image" | "video" | "audio" | "file" | "share" | "story_mention" | "ig_reel" | "reel" | "unsupported";
export type IgAttachment = { type: IgAttachmentType; url: string | null };

type Base = { accountId: string; at: string };
export type IgMessageEvent = Base & {
  kind: "message";
  /** The person's Instagram-scoped id: the sender, or for an echo the recipient. Never the account's own id. */
  igsid: string;
  mid: string;
  text: string | null;
  attachments: IgAttachment[];
  replyToStory: { id: string | null; url: string | null } | null;
  storyMention: { url: string | null } | null;
  quickReply: string | null;
  referral: IgReferral | null;
  /** Sent by the business (from the Instagram app, or through the API). */
  isEcho: boolean;
};
export type IgPostbackEvent = Base & {
  kind: "postback";
  igsid: string;
  mid: string;
  title: string | null;
  payload: string | null;
  referral: IgReferral | null;
};
export type IgReferralEvent = Base & { kind: "referral"; igsid: string; referral: IgReferral };
export type IgReactionEvent = Base & {
  kind: "reaction";
  igsid: string;
  mid: string;
  action: "react" | "unreact";
  emoji: string | null;
};
export type IgSeenEvent = Base & { kind: "seen"; igsid: string; mid: string };
export type IgUnsendEvent = Base & { kind: "unsend"; igsid: string; mid: string };
export type IgCommentEvent = Base & {
  kind: "comment";
  commentId: string;
  mediaId: string | null;
  mediaType: string | null;
  parentId: string | null;
  fromIgsid: string;
  fromUsername: string | null;
  text: string | null;
  adId: string | null;
  /** A comment on a live broadcast: a private reply only while it's live. */
  live: boolean;
};
export type IgEvent =
  | IgMessageEvent
  | IgPostbackEvent
  | IgReferralEvent
  | IgReactionEvent
  | IgSeenEvent
  | IgUnsendEvent
  | IgCommentEvent;

const ATTACHMENT_TYPES = new Set<IgAttachmentType>([
  "image",
  "video",
  "audio",
  "file",
  "share",
  "story_mention",
  "ig_reel",
  "reel",
]);

const id = z.union([z.string().min(1).max(200), z.number().int()]).transform(String);
const str = z.string().nullish();
/** Milliseconds (messaging) or seconds (changes): both read as the same moment. */
const when = (n: number) => new Date(n < 1e12 ? n * 1000 : n).toISOString();

const referral = z.object({
  ref: str,
  source: str,
  type: str,
  ad_id: id.nullish(),
  ads_context_data: z.object({ ad_title: str }).partial().nullish(),
});
const readReferral = (r: z.infer<typeof referral> | null | undefined): IgReferral | null =>
  r
    ? {
        source: r.source ?? null,
        type: r.type ?? null,
        adId: r.ad_id ?? null,
        ref: r.ref ?? null,
        adTitle: r.ads_context_data?.ad_title ?? null,
      }
    : null;

const attachment = z.object({ type: z.string(), payload: z.object({ url: z.string().nullish() }).nullish() });
const readAttachment = (a: unknown): IgAttachment => {
  const p = attachment.safeParse(a);
  if (!p.success || !ATTACHMENT_TYPES.has(p.data.type as IgAttachmentType))
    return { type: "unsupported", url: null };
  return { type: p.data.type as IgAttachmentType, url: p.data.payload?.url ?? null };
};

const party = z.object({ id });
const messaging = z.object({
  sender: party,
  recipient: party,
  timestamp: z.number().int().positive(),
  message: z
    .object({
      mid: z.string().min(1),
      text: z.string().nullish(),
      is_echo: z.boolean().nullish(),
      is_deleted: z.boolean().nullish(),
      attachments: z.array(z.unknown()).nullish(),
      reply_to: z
        .object({ story: z.object({ id: id.nullish(), url: str }).nullish() })

        .nullish(),
      quick_reply: z.object({ payload: z.string() }).nullish(),
      referral: referral.nullish(),
    })

    .optional(),
  postback: z
    .object({ mid: z.string().min(1), title: str, payload: str, referral: referral.nullish() })

    .optional(),
  referral: referral.optional(),
  reaction: z
    .object({ mid: z.string().min(1), action: z.enum(["react", "unreact"]), emoji: str })

    .optional(),
  read: z.object({ mid: z.string().min(1) }).optional(),
});

function readMessaging(accountId: string, raw: unknown): IgEvent | null {
  const p = messaging.safeParse(raw);
  if (!p.success) return null;
  const m = p.data;
  const at = when(m.timestamp);
  const msg = m.message;
  if (msg) {
    const isEcho = !!msg.is_echo;
    const igsid = isEcho ? m.recipient.id : m.sender.id;
    if (msg.is_deleted) return { kind: "unsend", accountId, igsid, mid: msg.mid, at };
    const attachments = (msg.attachments ?? []).map(readAttachment);
    const mention = attachments.find((a) => a.type === "story_mention");
    const story = msg.reply_to?.story;
    return {
      kind: "message",
      accountId,
      igsid,
      mid: msg.mid,
      at,
      text: msg.text ?? null,
      attachments,
      replyToStory: story ? { id: story.id ?? null, url: story.url ?? null } : null,
      storyMention: mention ? { url: mention.url } : null,
      quickReply: msg.quick_reply?.payload ?? null,
      referral: readReferral(msg.referral),
      isEcho,
    };
  }
  const igsid = m.sender.id;
  if (m.postback)
    return {
      kind: "postback",
      accountId,
      igsid,
      mid: m.postback.mid,
      at,
      title: m.postback.title ?? null,
      payload: m.postback.payload ?? null,
      referral: readReferral(m.postback.referral),
    };
  if (m.reaction)
    return {
      kind: "reaction",
      accountId,
      igsid,
      mid: m.reaction.mid,
      at,
      action: m.reaction.action,
      emoji: m.reaction.action === "react" ? (m.reaction.emoji ?? null) : null,
    };
  if (m.read) return { kind: "seen", accountId, igsid, mid: m.read.mid, at };
  if (m.referral) return { kind: "referral", accountId, igsid, at, referral: readReferral(m.referral)! };
  return null;
}

const commentValue = z.object({
  id: id.optional(),
  comment_id: id.optional(),
  text: str,
  parent_id: id.nullish(),
  from: z.object({ id, username: str }),
  media: z
    .object({ id: id.nullish(), media_product_type: str, ad_id: id.nullish() })

    .nullish(),
});
const change = z.object({ field: z.string(), value: z.unknown() });

function readChange(accountId: string, time: number, raw: unknown): IgEvent | null {
  const c = change.safeParse(raw);
  if (!c.success || (c.data.field !== "comments" && c.data.field !== "live_comments")) return null;
  const v = commentValue.safeParse(c.data.value);
  if (!v.success) return null;
  const commentId = v.data.id ?? v.data.comment_id;
  if (!commentId) return null;
  return {
    kind: "comment",
    accountId,
    commentId,
    mediaId: v.data.media?.id ?? null,
    mediaType: v.data.media?.media_product_type ?? null,
    parentId: v.data.parent_id ?? null,
    fromIgsid: v.data.from.id,
    fromUsername: v.data.from.username ?? null,
    text: v.data.text ?? null,
    at: when(time),
    adId: v.data.media?.ad_id ?? null,
    live: c.data.field === "live_comments",
  };
}

const entry = z.object({
  id,
  time: z.number().int().positive(),
  messaging: z.array(z.unknown()).optional(),
  changes: z.array(z.unknown()).optional(),
});
const body = z.object({ object: z.literal("instagram"), entry: z.array(z.unknown()) });

export function readInstagramWebhook(raw: unknown): IgEvent[] {
  const b = body.safeParse(raw);
  if (!b.success) return [];
  const out: IgEvent[] = [];
  for (const e of b.data.entry) {
    const p = entry.safeParse(e);
    if (!p.success) continue;
    for (const m of p.data.messaging ?? []) {
      const ev = readMessaging(p.data.id, m);
      if (ev) out.push(ev);
    }
    for (const c of p.data.changes ?? []) {
      const ev = readChange(p.data.id, p.data.time, c);
      if (ev) out.push(ev);
    }
  }
  return out;
}

/** Meta's ids are short; a long one is hashed so the key always fits its column. */
const short = (s: string) => (s.length <= 150 ? s : createHash("sha256").update(s).digest("hex"));

/** What keeps each delivery once (Meta retries for up to 36 hours). */
export function eventKey(e: IgEvent): string {
  switch (e.kind) {
    case "message":
      return `m:${short(e.mid)}`;
    case "postback":
      return `p:${short(e.mid)}`;
    case "reaction":
      // Its time too: react, unreact and react again (or a new emoji) are each their own.
      return `r:${short(e.mid)}:${e.action}:${short(e.igsid)}:${e.at}`;
    case "seen":
      return `s:${short(e.mid)}`;
    case "unsend":
      return `u:${short(e.mid)}`;
    case "comment":
      return `c:${short(e.commentId)}`;
    case "referral":
      return `ref:${short(e.igsid)}:${e.at}`;
  }
}
