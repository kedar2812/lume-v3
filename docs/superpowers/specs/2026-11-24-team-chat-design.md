# Team Chat (Phase 2, Feature C): design

Owner, 2026-11-24: "i want a really good chat feature, live typing indicator, profile photos, use the best features from
existing chat apps and add them all in lume" ... "you decide but lets get it all built you know, so that its easier to
sell". The brief: `LUME_NEW_FEATURES_PROMPT.md` §4. Phase order: `docs/NEW_FEATURES_PLAN.md` §3 (Phase 2).

## Why

Sales conversations about leads happen in personal WhatsApp today: no record, leads leak when someone leaves, and the
lead's details are copied by hand. Team Chat keeps that talk inside LUME, next to the lead, under the same access rules,
and fast enough that people choose it over WhatsApp. It is a selling point: "your team's talk about a lead stays with
the lead, and leaves with no one".

## Goals

1. Feels as quick and alive as WhatsApp: typing shows live, messages land instantly, photos, voice notes, reactions,
   replies to a message, ticks in direct messages, who's online.
2. Built for sales work, like Slack is for teams: channels, direct messages, threads, @mentions, and a thread on every
   lead that follows the lead's access.
3. Acts on leads without leaving the chat: live lead cards, `/assign`, `/stage`, `/remind`, `/note`, a message into a
   task, and `@LUME` (summarise, next step, draft a follow-up).
4. Holds 1,000 people on one LUME (the scale bar), on the client's own server, with no outside chat service.

## Non-goals (this phase)

- Voice or video calls, screen sharing.
- Chat with people outside the business (guests, clients).
- End-to-end encryption: an owner must be able to read and audit the team's talk about leads (brief: audit, no export
  for non-admins).
- Voice-note transcription (owner 2026-11-24: on hold with the Sarvam question). Voice notes are recorded and played;
  the transcript comes later.
- Link previews that fetch outside pages (a server fetching any URL a user pastes is an SSRF risk); links stay plain
  links, LUME's own links (a lead, a task) become cards.

## Anti-goals (a failure even if it works)

- A lead's name, phone or words reaching someone who can't see that lead: in a lead thread, a mention, a notification,
  a search result, a lead card or `@LUME`'s answer.
- Typing that lags, or messages that arrive out of order or twice.
- A generic chat app bolted on: it must look and move like LUME (Porcelain/Obsidian, the app's own frames, the Refresh
  morph, sounds only on achievements, never on clicks or messages by default).

## The shape (my calls, owner may overrule)

**Where it lives.** A new top-level "Chat" in the sidebar (unread count on it), a two-pane screen: conversations on the
left, the open conversation on the right, a thread opens as a third pane (a sheet on a phone). Every lead's drawer gets
a "Team" tab: its lead thread, the same component.

**The list (owner, 2026-11-24).** Channels, Direct messages and Lead threads are each a list that folds under its
heading, so the list never looks cluttered. A folded list shows the sum of its unread messages as a bubble on the
heading; an open one shows each conversation's own count. Folded or open is remembered per person, per list.

**Messages look like a phone's messenger (owner, 2026-11-24).** Each message is a bubble on its sender's profile photo
(the first bubble of a run points at the photo, the rest sit under it). Messages from others are on the left in a grey
bubble; the person's own are on the right in LUME's accent blue with white text. In a channel or lead thread the
first bubble of a run carries the sender's name; in a direct message it doesn't (there is one other person). The time
(and, on your own, the ticks) sits inside the bubble in its last line's corner; reactions sit on the bubble's lower
edge; quotes, lead cards, photos and voice notes are inside the bubble. The lead's Team tab and the phone use the
same bubbles.

**Conversations.** One table, three kinds:
- `channel`: named (#sales), with members. People see only the channels they are members of (owner, 2026-11-24):
  no browsing of other channels, and a channel that isn't yours never shows in your list, search or counts. Admins
  (`chat.channels.manage`) make and archive channels and add or remove members (people, or a whole team or role, which
  keeps them in as the team changes). Two made at setup: #general (everyone, kept so as people join) and #wins.
- `direct`: two to eight people; anyone can start one with anyone in the business.
- `lead`: one per lead, made on its first message; who can read it is exactly who can see the lead (row-level security
  joins the lead, like `instagram_flow_runs`).

**Messages.** Text (Markdown-lite: bold, italic, code, lists, links), up to 4,000 characters; attachments (photos,
files, voice notes up to 5 minutes) through LUME's existing file store and storage limits; reply to a message (a quote
above it); threads (replies under a message, shown as "4 replies" with faces); reactions (any emoji, top six quick);
edit (marked "edited", history kept for admins) and delete (leaves "This message was deleted", kept for audit until the
retention runs); pin (per conversation); @mention a person, @team, @channel (channel-wide only for admins or channels
under 50 people).

**Alive.** Typing ("Maya is typing…", up to three names, then "Several people are typing…"), presence (online dot:
a live stream open in the last 60 s), read state (direct messages show ticks: sent, delivered to their device, read;
channels show "Seen by 4" on your own last message only), unread counts and a "New messages" line, jump to first unread,
drafts kept per conversation, messages sent offline queue and go when back (shown with a clock until sent).

**Work.** Lead cards (paste or share a lead → a live card: name, stage, value, owner, last activity, quick actions under
the viewer's own permissions; a viewer who can't see the lead sees "A lead you can't open"); slash commands acting on
the current lead thread (`/assign @maya`, `/stage Won`, `/remind tomorrow 10am Call back`, `/note …`); any message into
a task (owner, due date; it appears on the lead and in the owner's tasks); `@LUME summarise`, `@LUME next step`,
`@LUME draft a follow-up` in a lead thread (metered as LUME AI, answers only from what the asker may see); handoff notes
(when LUME AI books a call it posts the summary into the lead thread and mentions the lead's owner).

**Find.** Search across what the person can read (Postgres full-text with `simple` config so Hindi/Marathi words match
as typed; filters: in, from, has file, mentions me), results open at the message.

**Notifications.** Mentions and direct messages notify (bell, and the existing email digest); a conversation can be
muted; "Do not disturb" hours from the person's working hours. Never a sound on a message unless the person turns
"Sound for direct messages" on (LUME's sound policy: achievements only by default).

**Admin.** Audit: every edit, delete, export and channel change is in the audit log; admins can read any channel and DM
through an audited "Review" view (the brief's audit requirement), people are told this in Settings › Chat. Retention:
messages kept for the business's chosen time (default: forever; 1, 2 or 5 years), files follow storage's keep-for. No
export for non-admins. Offboarding deletes all of it with the tenant.

## Approaches considered

1. **LUME's own chat on its existing live stream (chosen).** Postgres tables + the existing Server-Sent Events stream
   (one per tab, `/api/v1/stream`, pg `NOTIFY`) for new messages, edits, reactions, read state and typing; sends are
   plain POSTs. Typing and presence never touch a table (NOTIFY only). Fits the stack, the row-level security model and
   the one-server-per-client deployment; scales to 1,000 people because each event is one small NOTIFY fanned out by
   the existing hub, filtered per stream by membership held in memory.
2. A WebSocket server beside the API. Lower latency in theory, but a second connection type to secure, proxy, and keep
   alive on every client's box, duplicating the hub. Not worth it at this scale: SSE + POST measures in tens of ms.
3. An embedded chat product (Matrix/Synapse, Rocket.Chat, a hosted SDK). Heavy to run per client or sends data out;
   its access model can't follow LUME's lead visibility. Rejected.

## Scale and speed (the scale bar)

- 1,000 people, 200 online at once, a busy channel at 5 messages a second: each event is one NOTIFY (< 8 KB payload:
  ids and the message itself), the hub fans it to streams whose person is a member (membership cache per conversation,
  invalidated on change). Lead threads check visibility per recipient once per lead and cache it for the stream's life
  (invalidated on the existing "leads changed" event).
- Messages paged by keyset (`conversation_id, id`), 50 at a time; indexes for unread counts per member
  (`conversation_members.last_read_id`). Unread totals for the sidebar in one query.
- Typing: the browser sends at most one "typing" every 3 s while keys are pressed, the server NOTIFYs (no write), the
  others show it for 5 s after the last one.
- Search: GIN index on a `tsvector` column; capped at 200 results.
- Load test in the gate's scale suite: 1,000 members, 200 streams, 10,000 messages; p95 send→seen < 300 ms.

## Data (outline; the plan fixes columns)

`chat_conversations` (kind, name, lead_id, archived), `chat_members` (conversation, user, role, muted, last_read_id,
last_delivered_id), `chat_messages` (conversation, author user or LUME, body, reply_to, thread_root, edited_at,
deleted_at, kind: text/file/voice/card/system), `chat_message_edits`, `chat_reactions`, `chat_attachments` (file id,
kind, duration, waveform), `chat_pins`, `chat_channel_groups` (channel, team or role: its people are kept as members as
the team changes), `chat_list_folds` (person, list, folded). Row-level security: a member of the conversation, or for a lead thread anyone
who can see the lead; admin Review under an audited scope.

## Permissions (new)

`chat.use` (everyone by default), `chat.channels.manage` (admins), `chat.review` (owners; audited). Plan tiers: Team
Chat on every tier (brief: Base includes Team Chat); `@LUME` in chat uses the AI allowance.

## Screens (canvas first, then build)

Chat (two and three panes), a lead's Team tab, the composer (attachments, voice, slash menu, mention menu, emoji),
a thread, search, channel settings, Settings › Chat (retention, who can make channels, Review notice), phone layout.
Canvas boards built from LUME's real frames (Settings/Analytics shell), both themes, long names and huge counts.

## Build order

2A: conversations, messages, live stream events, typing, presence, unread, read ticks, replies, reactions, edit/delete,
photos and files, the Chat screen and the lead Team tab. 2B: threads, mentions and notifications, pins, search, voice
notes, drafts and the offline queue. 2C: lead cards, slash commands, message into a task, `@LUME`, handoff notes,
admin Review and retention. Each part: plan with edge-case sheet → tests first → mutation checks → full gate → fresh
review → push.

## Left to the builder

Exact column types and indexes, the NOTIFY payload format, the hub's membership cache structure, the emoji picker's
data source (a bundled list, no outside requests), waveform drawing, keyboard shortcuts (Ctrl K to jump, Up to edit the
last message, Esc to close a thread).
