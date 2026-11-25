import { bigint, bigserial, boolean, integer, pgTable, primaryKey, text, uuid } from "drizzle-orm/pg-core";
import { citext, tz } from "./types";

/** Team Chat (migration 0130; plan 2026-11-24-team-chat-2a): a channel, a direct message, or a lead's thread. */
export const chatConversations = pgTable("chat_conversations", {
  id: uuid("id").primaryKey(),
  kind: text("kind").$type<"channel" | "direct" | "lead">().notNull(),
  /** A channel's name (lower case, digits and dashes). */
  name: citext("name"),
  topic: text("topic"),
  leadId: uuid("lead_id"),
  /** A direct message's people, sorted and joined: one conversation per set of people. */
  directKey: text("direct_key"),
  createdBy: uuid("created_by"),
  createdAt: tz("created_at").notNull().defaultNow(),
  archivedAt: tz("archived_at"),
  lastMessageId: bigint("last_message_id", { mode: "number" }),
  lastAt: tz("last_at"),
});

/** Who is in a conversation and where each has read and received up to (a lead thread: only where they've read). */
export const chatMembers = pgTable(
  "chat_members",
  {
    conversationId: uuid("conversation_id").notNull(),
    userId: uuid("user_id").notNull(),
    via: text("via").$type<"person" | "group" | "lead">().notNull().default("person"),
    muted: boolean("muted").notNull().default(false),
    lastReadId: bigint("last_read_id", { mode: "number" }).notNull().default(0),
    lastDeliveredId: bigint("last_delivered_id", { mode: "number" }).notNull().default(0),
    joinedAt: tz("joined_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.conversationId, t.userId] })],
);

export const chatMessages = pgTable("chat_messages", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  conversationId: uuid("conversation_id").notNull(),
  /** Null: LUME wrote it. */
  authorId: uuid("author_id"),
  kind: text("kind").$type<"text" | "system">().notNull().default("text"),
  body: text("body"),
  replyTo: bigint("reply_to", { mode: "number" }),
  /** A reply in a thread: the message it hangs on. */
  threadRoot: bigint("thread_root", { mode: "number" }),
  /** A thread's reply also sent to the conversation. */
  alsoSent: boolean("also_sent").notNull().default(false),
  clientId: uuid("client_id"),
  editedAt: tz("edited_at"),
  deletedAt: tz("deleted_at"),
  createdAt: tz("created_at").notNull().defaultNow(),
});

export const chatMessageEdits = pgTable("chat_message_edits", {
  messageId: bigint("message_id", { mode: "number" }).notNull(),
  body: text("body").notNull(),
  editedAt: tz("edited_at").notNull().defaultNow(),
});

export const chatReactions = pgTable(
  "chat_reactions",
  {
    messageId: bigint("message_id", { mode: "number" }).notNull(),
    userId: uuid("user_id").notNull(),
    emoji: text("emoji").notNull(),
  },
  (t) => [primaryKey({ columns: [t.messageId, t.userId, t.emoji] })],
);

/** A photo or file in chat: the bytes are the file store's, by hash. Held by its sender until a message uses it. */
export const chatFiles = pgTable("chat_files", {
  id: uuid("id").primaryKey(),
  uploaderId: uuid("uploader_id").notNull(),
  messageId: bigint("message_id", { mode: "number" }),
  sha256: text("sha256").notNull(),
  name: text("name").notNull(),
  mime: text("mime").notNull(),
  kind: text("kind").$type<"image" | "video" | "audio" | "document">().notNull(),
  size: bigint("size", { mode: "number" }).notNull(),
  createdAt: tz("created_at").notNull().defaultNow(),
});

/** Who a channel keeps in: everyone, a team or a role. */
export const chatChannelGroups = pgTable("chat_channel_groups", {
  channelId: uuid("channel_id").notNull(),
  kind: text("kind").$type<"everyone" | "team" | "role">().notNull(),
  teamId: uuid("team_id"),
  roleId: uuid("role_id"),
});

/** Each person's lists, folded or open. */
export const chatListFolds = pgTable(
  "chat_list_folds",
  {
    userId: uuid("user_id").notNull(),
    list: text("list").$type<"channels" | "direct" | "leads">().notNull(),
    folded: boolean("folded").notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.list] })],
);

/** A thread as its root shows it (migration 0131): kept by triggers as replies land and are deleted. */
export const chatThreads = pgTable("chat_threads", {
  rootId: bigint("root_id", { mode: "number" }).primaryKey(),
  conversationId: uuid("conversation_id").notNull(),
  replies: integer("replies").notNull().default(0),
  lastReplyId: bigint("last_reply_id", { mode: "number" }).notNull(),
  lastAt: tz("last_at").notNull(),
  faces: uuid("faces").array().notNull().default([]),
});

/** Who follows a thread and where each has read to. */
export const chatThreadPlaces = pgTable(
  "chat_thread_places",
  {
    rootId: bigint("root_id", { mode: "number" }).notNull(),
    userId: uuid("user_id").notNull(),
    following: boolean("following").notNull().default(true),
    lastReadId: bigint("last_read_id", { mode: "number" }).notNull().default(0),
    lastReplyId: bigint("last_reply_id", { mode: "number" }).notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.rootId, t.userId] })],
);

/** Who a message names (migration 0132): by their own name, or through a team or the whole channel. */
export const chatMentions = pgTable(
  "chat_mentions",
  {
    messageId: bigint("message_id", { mode: "number" }).notNull(),
    userId: uuid("user_id").notNull(),
    byName: boolean("by_name").notNull(),
    conversationId: uuid("conversation_id").notNull(),
    /** The thread it was said in; 0: none. */
    root: bigint("root", { mode: "number" }).notNull().default(0),
    /** They have looked there since it named them. */
    seen: boolean("seen").notNull().default(false),
  },
  (t) => [primaryKey({ columns: [t.messageId, t.userId] })],
);
