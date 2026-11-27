# Instagram comment actions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** on a lead's Instagram tab, a person can reply publicly to a comment, hide or unhide it, and delete it, so
LUME does what Meta's App Review recording for `instagram_business_manage_comments` asks (create, update, delete a
comment; shown in LUME and in Instagram). Kit: `F:/projects kedar/lume-meta-review/2026-11-instagram/README.md`.

**Ruling (owner asleep, 2026-11-27):** built ahead of the owner's decision 1 in the kit, because the review is likely
refused without it; nothing is deployed, and the owner can drop it before release. Cost if wrong: a small feature to
remove.

**Architecture:** three routes call Instagram's Graph API at once (one call each, Graph's own 15-second limit) under
the comment's row lock, then keep the result on `instagram_comments` (migration 0137: `hidden`, `deleted_at`,
`public_reply`, `public_reply_id`). The lead's Instagram view carries them; the tab shows the state and the actions.

## Global Constraints

- Who: `messages.send` on the lead, as Reply privately; the account connected. Row-level security decides the comment.
- Instagram can't edit a comment's words: "update" is Hide/Unhide. Comments on the account's own media only (all
  LUME receives).
- Words: "Reply publicly", "Hide", "Unhide", "Delete" then "Delete from Instagram?" (asked twice, as Team Chat);
  states "Hidden on Instagram", "Deleted from Instagram", "Replied publicly: …". A refusal: Instagram's own reason in
  words, else "Instagram didn't take that. Try again." No em dashes, speaks as LUME.
- A public reply: 1 to 2,200 characters (Instagram's limit), once per comment from LUME; a live comment can't be
  answered after the live (as private replies).

## Edge-case sheet

| Input | Expected |
|---|---|
| Hide twice / unhide a shown one | answers as it is now, no Meta call |
| Delete twice (double tap, two tabs) | the second finds it deleted: 200 with the comment as it is, no second call |
| Meta says the comment no longer exists | marked deleted (it is gone) |
| Meta busy / unreachable | 502 with words; nothing kept as changed |
| Token revoked (190) | 409 "connect this account again" (as sending) |
| Account disconnected | 409 ACCOUNT_NOT_READY |
| A deleted comment | no actions; replying or hiding refused 409 COMMENT_DELETED |
| Someone who can't see the lead | 404 |
| No messages.send | 403 |
| Public reply twice | 409 PUBLIC_REPLY_DONE (a flow's counts too) |
| Public reply empty / 2,201 chars | 400 |
| Long words at 375px | wraps |

## Review Focus

1. Never a second Meta call for the same delete or the same public reply (row lock, state check).
2. Meta's refusal must not leave LUME saying it happened.
3. A comment someone can't see must never be acted on (RLS + lead check).
4. The audit log records hide, unhide, delete and public reply.
5. The flow's own public reply (sendPublicReply) and this one never both go.

### Task 1: API (migration 0137, graph.ts hide/remove, comment-actions.ts, routes, probes, thread view)
Tests: `apps/api/src/modules/instagram/comment-actions.test.ts`.

### Task 2: the tab (InstagramTab CommentRow actions and states, client)
Tests: `apps/web/src/components/leads/drawer/InstagramTab.test.tsx` additions.
