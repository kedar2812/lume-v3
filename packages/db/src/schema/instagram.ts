import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  smallint,
  text,
  uuid,
} from "drizzle-orm/pg-core";
import { bytea, tz } from "./types";

/** Instagram, the channel (NEW_FEATURES_PLAN §5.1; migration 0118): a connected professional account. */
export const instagramAccounts = pgTable("instagram_accounts", {
  id: uuid("id").primaryKey(),
  /** The account's Instagram id: what Meta's webhooks carry as `entry.id`. */
  igUserId: text("ig_user_id").notNull().unique(),
  username: text("username").notNull(),
  name: text("name"),
  accountType: text("account_type"),
  /** Whose account it is; null: the business's. */
  ownerUserId: uuid("owner_user_id"),
  /** Who connected it: its jobs run as them. */
  runAs: uuid("run_as").notNull(),
  /** The lead source its new leads come in under (type instagram). */
  sourceId: uuid("source_id"),
  tokenEnc: bytea("token_enc"),
  /** When the token was given or last refreshed (Meta's last 60 days). */
  tokenAt: tz("token_at"),
  status: text("status").$type<"active" | "needs_attention" | "disconnected">().notNull(),
  problem: text("problem"),
  newDmCreatesLead: boolean("new_dm_creates_lead").notNull().default(true),
  /** Sent once at a flow's start where the law asks automation to say so (0123); null: none. */
  automatedNote: text("automated_note"),
  /** Words that ask for a person at any point of a run (0123). */
  personWords: text("person_words")
    .array()
    .notNull()
    .default(sql`'{PERSON}'`),
  /** The relay's signature that this account was connected here (0122): shown back when the relay rebuilds. */
  relayGrant: text("relay_grant"),
  connectedAt: tz("connected_at").notNull().defaultNow(),
  updatedAt: tz("updated_at").notNull().defaultNow(),
});

export type InstagramEventKind =
  "message" | "postback" | "referral" | "reaction" | "seen" | "unsend" | "comment";
/** Each delivery, once; its event encrypted while it waits, cleared when processed. */
export const instagramEvents = pgTable("instagram_events", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  accountIgId: text("account_ig_id").notNull(),
  eventKey: text("event_key").notNull(),
  kind: text("kind").$type<InstagramEventKind>().notNull(),
  eventEnc: bytea("event_enc"),
  status: text("status").$type<"queued" | "done" | "error">().notNull(),
  problem: text("problem"),
  tries: integer("tries").notNull().default(0),
  receivedAt: tz("received_at").notNull().defaultNow(),
  processedAt: tz("processed_at"),
});

export type InstagramThreadSource = {
  trigger?: string;
  keyword?: string;
  mediaId?: string;
  adId?: string;
  ref?: string;
};
/** A conversation: one person on one account. No lead: it waits in Not a lead yet. */
export const instagramThreads = pgTable("instagram_threads", {
  id: uuid("id").primaryKey(),
  accountId: uuid("account_id").notNull(),
  igsid: text("igsid").notNull(),
  leadId: uuid("lead_id"),
  username: text("username"),
  name: text("name"),
  lastInAt: tz("last_in_at"),
  adWindowUntil: tz("ad_window_until"),
  lastOutAt: tz("last_out_at"),
  lastMessageAt: tz("last_message_at"),
  takenOverBy: uuid("taken_over_by"),
  takenOverAt: tz("taken_over_at"),
  source: jsonb("source")
    .$type<InstagramThreadSource>()
    .notNull()
    .default(sql`'{}'::jsonb`),
  profileReadAt: tz("profile_read_at"),
  photoSha256: text("photo_sha256"),
  photoMime: text("photo_mime"),
  photoCheckedAt: tz("photo_checked_at"),
  createdAt: tz("created_at").notNull().defaultNow(),
  updatedAt: tz("updated_at").notNull().defaultNow(),
});

export const instagramIgnored = pgTable(
  "instagram_ignored",
  {
    accountId: uuid("account_id").notNull(),
    igsid: text("igsid").notNull(),
    createdAt: tz("created_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.accountId, t.igsid] })],
);

export type PrivateReplyState = "none" | "queued" | "sent" | "failed";
/** A comment on the business's post or reel, and its one private reply. */
export const instagramComments = pgTable("instagram_comments", {
  id: uuid("id").primaryKey(),
  accountId: uuid("account_id").notNull(),
  commentId: text("comment_id").notNull().unique(),
  mediaId: text("media_id"),
  mediaType: text("media_type"),
  parentId: text("parent_id"),
  fromIgsid: text("from_igsid").notNull(),
  fromUsername: text("from_username"),
  text: text("text"),
  adId: text("ad_id"),
  live: boolean("live").notNull().default(false),
  at: tz("at").notNull(),
  threadId: uuid("thread_id"),
  privateReply: text("private_reply").$type<PrivateReplyState>().notNull().default("none"),
  privateReplyAt: tz("private_reply_at"),
  publicReplyAt: tz("public_reply_at"),
  createdAt: tz("created_at").notNull().defaultNow(),
});

export type InstagramOutboxStatus = "queued" | "sending" | "sent" | "read" | "failed" | "cancelled";
/** A message LUME sends on Instagram, from Send until Meta took it, or why not. Seen exactly as its lead is. */
export const instagramOutbox = pgTable("instagram_outbox", {
  id: uuid("id").primaryKey(),
  threadId: uuid("thread_id").notNull(),
  leadId: uuid("lead_id").notNull(),
  accountId: uuid("account_id").notNull(),
  userId: uuid("user_id").notNull(),
  activityId: uuid("activity_id"),
  clientKey: uuid("client_key").notNull(),
  kind: text("kind").$type<"dm" | "private_reply">().notNull(),
  commentId: text("comment_id"),
  text: text("text"),
  mediaId: uuid("media_id"),
  quickReplies: jsonb("quick_replies").$type<{ title: string; payload: string }[]>(),
  buttons: jsonb("buttons").$type<{ title: string; url: string }[]>(),
  tag: text("tag").$type<"human_agent">(),
  flowRunId: uuid("flow_run_id"),
  stepKey: text("step_key"),
  status: text("status").$type<InstagramOutboxStatus>().notNull(),
  mid: text("mid").unique(),
  reaction: text("reaction"),
  problem: text("problem"),
  tries: integer("tries").notNull().default(0),
  createdAt: tz("created_at").notNull().defaultNow(),
  updatedAt: tz("updated_at").notNull().defaultNow(),
});

/** Not a lead yet (0119): a message from someone no lead has yet, kept 14 days on its conversation. */
export const instagramInbox = pgTable("instagram_inbox", {
  id: uuid("id").primaryKey(),
  threadId: uuid("thread_id").notNull(),
  mid: text("mid").notNull().unique(),
  at: tz("at").notNull(),
  text: text("text"),
  detail: jsonb("detail")
    .$type<Record<string, unknown>>()
    .notNull()
    .default(sql`'{}'::jsonb`),
  unsent: boolean("unsent").notNull().default(false),
  createdAt: tz("created_at").notNull().defaultNow(),
});

/** A photo, video, voice note or file a person sent, kept once on this server's disk. */
export const instagramMedia = pgTable("instagram_media", {
  id: uuid("id").primaryKey(),
  accountId: uuid("account_id").notNull(),
  threadId: uuid("thread_id").notNull(),
  leadId: uuid("lead_id"),
  mid: text("mid").notNull(),
  position: smallint("position").notNull().default(0),
  url: text("url").notNull(),
  kind: text("kind").$type<"image" | "video" | "audio" | "file">().notNull(),
  mime: text("mime"),
  size: integer("size"),
  sha256: text("sha256"),
  status: text("status").$type<"waiting" | "ready" | "too_large" | "failed" | "gone">().notNull(),
  problem: text("problem"),
  tries: integer("tries").notNull().default(0),
  retryAt: tz("retry_at"),
  createdAt: tz("created_at").notNull().defaultNow(),
});

/** Flows (0123; plan 1B): what a business builds to answer comments and DMs. Configuration. */
export const instagramFlows = pgTable("instagram_flows", {
  id: uuid("id").primaryKey(),
  name: text("name").notNull(),
  status: text("status").$type<"draft" | "live" | "paused" | "archived">().notNull(),
  liveVersionId: uuid("live_version_id"),
  priority: integer("priority").notNull().default(0),
  draftSteps: jsonb("draft_steps")
    .$type<unknown[]>()
    .notNull()
    .default(sql`'[]'::jsonb`),
  rev: integer("rev").notNull().default(1),
  rr: bigint("rr", { mode: "number" }).notNull().default(0),
  createdBy: uuid("created_by").notNull(),
  createdAt: tz("created_at").notNull().defaultNow(),
  updatedAt: tz("updated_at").notNull().defaultNow(),
});

/** A published version: its steps never change (a trigger refuses an update). */
export const instagramFlowVersions = pgTable("instagram_flow_versions", {
  id: uuid("id").primaryKey(),
  flowId: uuid("flow_id").notNull(),
  version: integer("version").notNull(),
  steps: jsonb("steps").$type<unknown[]>().notNull(),
  createdBy: uuid("created_by").notNull(),
  createdAt: tz("created_at").notNull().defaultNow(),
});

export type InstagramTriggerKind = "comment" | "dm" | "story_reply" | "story_mention" | "ad" | "welcome";
export const instagramTriggers = pgTable("instagram_triggers", {
  id: uuid("id").primaryKey(),
  flowId: uuid("flow_id").notNull(),
  accountId: uuid("account_id"),
  kind: text("kind").$type<InstagramTriggerKind>().notNull(),
  keywords: text("keywords")
    .array()
    .notNull()
    .default(sql`'{}'`),
  mode: text("mode").$type<"word" | "exact" | "any">().notNull().default("word"),
  mediaIds: text("media_ids")
    .array()
    .notNull()
    .default(sql`'{}'`),
  adIds: text("ad_ids")
    .array()
    .notNull()
    .default(sql`'{}'`),
  publicReplies: text("public_replies")
    .array()
    .notNull()
    .default(sql`'{}'`),
  cooldownHours: integer("cooldown_hours").notNull().default(24),
  enabled: boolean("enabled").notNull().default(true),
  createdAt: tz("created_at").notNull().defaultNow(),
});

export type InstagramRunStatus = "running" | "waiting" | "done" | "stopped" | "handed" | "failed";
/** A conversation in a flow; one running or waiting at a time per conversation. Seen as its lead is. */
export const instagramFlowRuns = pgTable("instagram_flow_runs", {
  id: uuid("id").primaryKey(),
  flowId: uuid("flow_id").notNull(),
  versionId: uuid("version_id").notNull(),
  triggerId: uuid("trigger_id"),
  threadId: uuid("thread_id").notNull(),
  leadId: uuid("lead_id").notNull(),
  status: text("status").$type<InstagramRunStatus>().notNull(),
  state: jsonb("state").$type<Record<string, unknown>>().notNull(),
  startedBy: text("started_by").notNull(),
  keyword: text("keyword"),
  nextAt: tz("next_at"),
  reason: text("reason"),
  tries: integer("tries").notNull().default(0),
  createdAt: tz("created_at").notNull().defaultNow(),
  updatedAt: tz("updated_at").notNull().defaultNow(),
});

export const instagramFlowEvents = pgTable("instagram_flow_events", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  flowId: uuid("flow_id").notNull(),
  versionId: uuid("version_id"),
  triggerId: uuid("trigger_id"),
  runId: uuid("run_id"),
  stepKey: text("step_key"),
  keyword: text("keyword"),
  kind: text("kind")
    .$type<
      "triggered" | "private_reply" | "dm_sent" | "replied" | "lead_created" | "call_booked" | "handed"
    >()
    .notNull(),
  leadId: uuid("lead_id"),
  at: tz("at").notNull().defaultNow(),
});
