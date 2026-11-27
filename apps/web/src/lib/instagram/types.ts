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
  /** Who answers a DM no flow claims (plan 2026-11-27-instagram-lume-ai): the team, or LUME AI. */
  newDms: "team" | "ai";
  /** The account's standing LUME AI run ("New DMs on @account"), if it has one: running, or paused and why (review M4). */
  aiRun?: { id: string; status: "running" | "paused"; pauseReason: string | null } | null;
  limits: { newLeadsPerHour: number; mediaMbPerPersonDay: number; mediaMbPerDay: number };
  sourceId: string | null;
  connectedAt: string;
};
/** What LUME AI aims for on Instagram: a goal stage, or the business's own words. */
export type IgAiGoal = { kind: "stage"; stageId: string } | { kind: "brief"; text: string };
export type IgAccounts = {
  accounts: IgAccount[];
  /** Whether LUME AI may answer Instagram here (why not, in words), what it aims for, and the goal stages to pick from. */
  ai?: {
    ok: boolean;
    why?: string;
    goal: IgAiGoal | { kind: "reply" };
    stages: { id: string; name: string }[];
  };
};

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
  /** Written by LUME AI, as its speaker (sentBy). */
  ai?: boolean;
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
  /** What Instagram shows now, after a person's actions from LUME (2026-11-27); absent from an older LUME. */
  hidden?: boolean;
  deleted?: boolean;
  publicReply?: string | null;
  /** That reply's answer never came from Instagram: it may be there; never sent again by itself. */
  publicReplyUnsure?: boolean;
  /** A public reply can still go from LUME (none yet, not deleted, not a live's). */
  canReplyPublicly?: boolean;
};
/** A comment as Instagram shows it after an action. */
export type IgCommentState = {
  hidden: boolean;
  deleted: boolean;
  publicReply: string | null;
  publicReplyUnsure: boolean;
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
  /** LUME AI answering it (its run on this account holds the lead), paused or not. */
  ai?: { runId: string; paused: boolean } | null;
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
