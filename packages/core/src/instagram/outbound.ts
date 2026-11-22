import type { IgOutMessage } from "./limits";

/** Who a message goes to: a person in a conversation, or a commenter (a private reply, once per comment). */
export type IgTarget = { igsid: string } | { commentId: string };

/** The Send API's JSON (`POST /<IG_ID>/messages`) for one message. */
export function igOutboundBody(to: IgTarget, m: IgOutMessage, tag?: "HUMAN_AGENT"): Record<string, unknown> {
  const recipient = "commentId" in to ? { comment_id: to.commentId } : { id: to.igsid };
  let message: Record<string, unknown>;
  if (m.buttons?.length)
    message = {
      attachment: {
        type: "template",
        payload: {
          template_type: "button",
          text: m.text ?? "",
          buttons: m.buttons.map((b) => ({ type: "web_url", url: b.url, title: b.title })),
        },
      },
    };
  else if (m.mediaUrl)
    message = { attachment: { type: m.mediaKind ?? "file", payload: { url: m.mediaUrl } } };
  else
    message = {
      text: m.text ?? "",
      ...(m.quickReplies?.length
        ? {
            quick_replies: m.quickReplies.map((q) => ({
              content_type: "text",
              title: q.title,
              payload: q.payload,
            })),
          }
        : {}),
    };
  return { recipient, ...(tag ? { messaging_type: "MESSAGE_TAG", tag } : {}), message };
}

export type IgRefusal = {
  code: "TOKEN" | "BUSY" | "WINDOW" | "UNAVAILABLE" | "REFUSED" | "META_DOWN";
  words: string;
  retry: boolean;
  token: boolean;
};

const RATE = new Set([4, 17, 32, 613, 80002]);

/** Meta's answer to a send that didn't go, as LUME says it and acts on it. */
export function refusalOfIg(status: number, body: unknown): IgRefusal {
  const e = (body as { error?: { code?: unknown; error_subcode?: unknown } } | null)?.error;
  const code = typeof e?.code === "number" ? e.code : null;
  const sub = typeof e?.error_subcode === "number" ? e.error_subcode : null;
  if (code === 190)
    return {
      code: "TOKEN",
      words: "Instagram stopped letting LUME in. An admin can connect the account again.",
      retry: false,
      token: true,
    };
  if (code !== null && RATE.has(code))
    return {
      code: "BUSY",
      words: "Instagram asked LUME to slow down. LUME will try again.",
      retry: true,
      token: false,
    };
  if (code === 10 || sub === 2534022)
    return {
      code: "WINDOW",
      words: "Instagram only allows a reply within its time limit after the person's last message.",
      retry: false,
      token: false,
    };
  if (code === 551)
    return {
      code: "UNAVAILABLE",
      words: "This person can't get messages from you on Instagram right now.",
      retry: false,
      token: false,
    };
  if (code === null && (status === 0 || status >= 500))
    return {
      code: "META_DOWN",
      words: "Instagram didn't answer. LUME will try again.",
      retry: true,
      token: false,
    };
  return { code: "REFUSED", words: "Instagram didn't take this message.", retry: false, token: false };
}
