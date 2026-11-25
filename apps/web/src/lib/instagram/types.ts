/** A connected Instagram account, as Settings → Integrations shows it: never a token. */
export type IgAccount = {
  id: string;
  username: string;
  name: string | null;
  /** Whose account: a person's, or null for the business. */
  owner: { id: string; name: string } | null;
  status: "active" | "needs_attention";
  problem: string | null;
  /** New people who write become leads (true) or wait in Not a lead yet (false). */
  newDmCreatesLead: boolean;
  limits: { newLeadsPerHour: number; mediaMbPerPersonDay: number; mediaMbPerDay: number };
  sourceId: string | null;
  connectedAt: string;
};
export type IgAccounts = { accounts: IgAccount[] };

/** One message in a lead's Instagram conversation (API: GET /leads/:id/instagram). */
export type IgMessage = {
  id: string;
  direction: "in" | "out";
  at: string;
  text: string | null;
  /** What came with it: attachment kinds, a story, a tap, an ad, a flow's buttons or quick replies. */
  detail: Record<string, unknown>;
  /** The person took it back on Instagram: its words are gone. */
  unsent: boolean;
  /** Sent from LUME: who, where it got to, and why it failed; null for the rest. */
  sentBy: { id: string; name: string } | null;
  status: "queued" | "sending" | "sent" | "read" | "failed" | "cancelled" | null;
  problem: string | null;
  reaction: string | null;
  outboxId: string | null;
  /** Sent by a flow: its name. */
  flow: string | null;
  /** Sent from Instagram itself by someone at the business. */
  fromPhone: boolean;
  /** Sent with Meta's human agent tag (a person, after 24 hours). */
  humanAgent: boolean;
  /** The one private reply to a comment. */
  privateReply: boolean;
};
/** Meta's window for a conversation now: open to everyone, to a person only (7 days), or closed. */
export type IgWindow =
  | { state: "open"; until: string }
  | { state: "human"; until: string }
  | { state: "closed"; since: string | null };
export type IgComment = {
  id: string;
  at: string;
  text: string | null;
  mediaType: string | null;
  privateReply: "none" | "queued" | "sent" | "failed";
  /** Its one private reply can still go (within 7 days, not sent yet). */
  replyOpen: boolean;
};
export type IgThread = {
  id: string;
  account: { id: string; username: string; connected: boolean };
  /** Masked as the lead's handle is; null where the role can't see it. */
  person: { name: string | null; username: string | null };
  window: IgWindow;
  takenOver: { id: string; name: string } | null;
  /** The flow it's in now. */
  flow: { id: string; name: string; waiting: boolean } | null;
  comments: IgComment[];
  source: Record<string, unknown> | null;
  messages: IgMessage[];
};

/** Someone in Not a lead yet from Instagram (API: GET /instagram/inbox); the handle is masked as the server decides. */
export type IgInboxPerson = {
  threadId: string;
  /** Without the "@". */
  username: string | null;
  name: string | null;
  account: { id: string; username: string };
  count: number;
  lastText: string | null;
  lastAt: string;
};
export type IgInboxMessage = {
  id: string;
  at: string;
  text: string | null;
  unsent: boolean;
  detail: Record<string, unknown>;
};
