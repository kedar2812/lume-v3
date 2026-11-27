import { randomUUID } from "node:crypto";
import { ALL_GRANTS } from "@lume/core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { IGSID } from "../../../../../packages/core/src/instagram/fixtures";
import { createHarness, type Harness } from "../../../test/harness";
import { IG_RELAY_TOKEN, seedIgAccount } from "../../../test/instagram";
import { fakeAccount, startInstagramFake, type InstagramFake } from "../../../test/instagram-fake";
import { sendPublicReply } from "./flow-due";
import { igPacer } from "./sender";

/**
 * A person answering, hiding or deleting a comment from a lead's Instagram tab (plan 2026-11-27-instagram-comment-actions;
 * what Meta's App Review asks of instagram_business_manage_comments: create, update, delete).
 */
const H = 3_600_000;
let h: Harness;
let ig: InstagramFake;
let admin: { id: string; email: string; password: string };
let rep: { id: string; email: string; password: string };
let other: { id: string; email: string; password: string };
let viewer: { id: string; email: string; password: string };
let account: { id: string; sourceId: string };
let leadId: string;
let threadId: string;

const act = (u: typeof rep, id: string, what: "public-reply" | "hide" | "delete", payload?: object) =>
  h.signIn(u).then((c) =>
    c.inject({
      method: what === "delete" ? "DELETE" : "POST",
      url:
        what === "delete" ? `/api/v1/instagram/comments/${id}` : `/api/v1/instagram/comments/${id}/${what}`,
      ...(payload ? { payload } : {}),
    }),
  );
const metaCalls = (commentId = "C1") => ig.calls.filter((c) => c.path.includes(`/${commentId}`));
const row = async (id: string) =>
  (
    await h.queryAll<{
      hidden: boolean;
      deleted_at: Date | null;
      public_reply: string | null;
      public_reply_id: string | null;
      public_reply_unsure: boolean;
    }>(
      "SELECT hidden, deleted_at, public_reply, public_reply_id, public_reply_unsure FROM instagram_comments WHERE id = $1",
      [id],
    )
  )[0]!;
async function comment(o: { live?: boolean; publicReplyAt?: Date } = {}) {
  const id = randomUUID();
  await h.queryAll(
    `INSERT INTO instagram_comments (id, account_id, comment_id, media_id, from_igsid, from_username, text, at, thread_id, live, public_reply_at)
     VALUES ($1, $2, 'C1', 'M1', $3, 'priya.shah', 'PRICE', $4, $5, $6, $7)`,
    [
      id,
      account.id,
      IGSID,
      new Date(h.clock.now.getTime() - H),
      threadId,
      o.live ?? false,
      o.publicReplyAt ?? null,
    ],
  );
  return id;
}

beforeAll(async () => {
  ig = await startInstagramFake();
  h = await createHarness({
    oauth: { relayToken: IG_RELAY_TOKEN },
    instagramGraph: { graphUrl: ig.graphUrl, version: ig.version },
  });
  h.setRelayUrl("https://relay.test");
  h.clock.now = new Date("2026-11-22T06:10:00Z");
  admin = await h.seedUser({ owner: true, grants: ALL_GRANTS, totp: true });
  rep = await h.seedUser({
    name: "Rhea Rep",
    grants: [
      { key: "leads.view", scope: "own" },
      { key: "messages.send", scope: "own" },
    ],
  });
  other = await h.seedUser({
    grants: [
      { key: "leads.view", scope: "own" },
      { key: "messages.send", scope: "own" },
    ],
  });
  viewer = await h.seedUser({ grants: [{ key: "leads.view", scope: "all" }] });
});
afterAll(async () => {
  await h.close();
  await ig.close();
});
beforeEach(async () => {
  h.clock.advance(H);
  await h.ownerPool.query(
    "TRUNCATE leads, activities, instagram_threads, instagram_events, instagram_comments, instagram_outbox CASCADE",
  );
  await h.ownerPool.query("DELETE FROM instagram_accounts");
  await h.ownerPool.query("DELETE FROM lead_sources WHERE type = 'instagram'");
  ig.calls.length = 0;
  ig.publicReplies.length = 0;
  ig.commentFail.length = 0;
  ig.hidden.clear();
  ig.deleted.clear();
  ig.missing.clear();
  ig.tokens.clear();
  ig.revoked.clear();
  ig.tokens.set("IGQlong-account-token", fakeAccount());
  account = await seedIgAccount(h, { runAs: admin.id });
  leadId = await h.seedLead({ ownerId: rep.id, name: "Priya Shah" });
  threadId = randomUUID();
  await h.queryAll(
    "INSERT INTO instagram_threads (id, account_id, igsid, lead_id, last_in_at) VALUES ($1, $2, $3, $4, $5)",
    [threadId, account.id, IGSID, leadId, new Date(h.clock.now.getTime() - H)],
  );
});

describe("a public reply under a comment (create)", () => {
  it("goes to Instagram once, is kept with its words, and shows on the lead's Instagram tab", async () => {
    const id = await comment();
    const r = await act(rep, id, "public-reply", { text: "Sent you the prices in a DM" });
    expect(r.statusCode, r.body).toBe(200);
    expect(ig.publicReplies).toEqual([{ commentId: "C1", message: "Sent you the prices in a DM" }]);
    expect(await row(id)).toMatchObject({ public_reply: "Sent you the prices in a DM" });
    expect((await row(id)).public_reply_id).toBeTruthy();
    const again = await act(rep, id, "public-reply", { text: "Again" });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe("PUBLIC_REPLY_DONE");
    expect(ig.publicReplies).toHaveLength(1);
    const view = (
      await (await h.signIn(rep)).inject({ method: "GET", url: `/api/v1/leads/${leadId}/instagram` })
    ).json();
    expect(view.threads[0].comments[0]).toMatchObject({
      hidden: false,
      deleted: false,
      publicReply: "Sent you the prices in a DM",
    });
  });

  it("Instagram's answer lost: kept as maybe there, never sent again by itself, and the tab says to check", async () => {
    const id = await comment();
    ig.commentFail.push("lose");
    const r = await act(rep, id, "public-reply", { text: "Sent you the prices" });
    expect(r.statusCode).toBe(502);
    expect(r.json().error.code).toBe("INSTAGRAM_UNSURE");
    expect(await row(id)).toMatchObject({ public_reply: "Sent you the prices", public_reply_unsure: true });
    expect((await act(rep, id, "public-reply", { text: "Again" })).json().error.code).toBe(
      "PUBLIC_REPLY_DONE",
    );
    expect(ig.publicReplies).toHaveLength(1);
    const view = (
      await (await h.signIn(rep)).inject({ method: "GET", url: `/api/v1/leads/${leadId}/instagram` })
    ).json();
    expect(view.threads[0].comments[0]).toMatchObject({ publicReplyUnsure: true, canReplyPublicly: false });
    const log = await h.queryAll<{ action: string }>("SELECT action FROM audit_log WHERE entity_id = $1", [
      id,
    ]);
    expect(log.map((l) => l.action)).toEqual(["instagram.comment_replied"]);
  });

  it("a comment deleted in the Instagram app: replying says so, and LUME marks it deleted", async () => {
    const id = await comment();
    ig.missing.add("C1");
    const r = await act(rep, id, "public-reply", { text: "Hi" });
    expect(r.json().error.code).toBe("COMMENT_DELETED");
    expect((await row(id)).deleted_at).not.toBeNull();
  });

  it("a flow's public reply Instagram refused: the comment is free for a person to answer", async () => {
    const id = await comment({ publicReplyAt: new Date() });
    ig.commentFail.push(10);
    const deps = { app: h.app, d: h.deps, pacer: igPacer({ now: () => h.clock.now, perSecond: 20 }) };
    expect(await sendPublicReply(deps, "C1", "Sent you a DM!")).toBe("refused");
    expect((await act(rep, id, "public-reply", { text: "Here are the prices" })).statusCode).toBe(200);
    // Taken: kept with Instagram's id.
    await h.queryAll("UPDATE instagram_comments SET comment_id = 'C0' WHERE id = $1", [id]);
    const other = await comment({ publicReplyAt: new Date() });
    expect(await sendPublicReply(deps, "C1", "Sent you a DM!")).toBe("sent");
    expect((await row(other)).public_reply_id).toBeTruthy();
  });

  it("one a flow already answered publicly can't be answered again", async () => {
    const id = await comment({ publicReplyAt: new Date() });
    expect((await act(rep, id, "public-reply", { text: "Hello" })).json().error.code).toBe(
      "PUBLIC_REPLY_DONE",
    );
    expect(ig.publicReplies).toEqual([]);
  });

  it("words: empty or over Instagram's 2,200 characters are refused before Instagram", async () => {
    const id = await comment();
    expect((await act(rep, id, "public-reply", { text: "" })).statusCode).toBe(400);
    expect((await act(rep, id, "public-reply", { text: "a".repeat(2201) })).statusCode).toBe(400);
    expect((await act(rep, id, "public-reply", { text: "a".repeat(2200) })).statusCode).toBe(200);
  });

  it("a live comment after the live: Instagram doesn't allow an answer", async () => {
    const id = await comment({ live: true });
    expect((await act(rep, id, "public-reply", { text: "Hi" })).json().error.code).toBe("LIVE_COMMENT");
  });
});

describe("hide and unhide (Instagram's only update to a comment)", () => {
  it("hides on Instagram, then shows it again; the same again asks Instagram nothing", async () => {
    const id = await comment();
    const hid = await act(rep, id, "hide", { hidden: true });
    expect(hid.statusCode, hid.body).toBe(200);
    expect(ig.hidden.has("C1")).toBe(true);
    expect((await row(id)).hidden).toBe(true);
    const calls = metaCalls().length;
    expect((await act(rep, id, "hide", { hidden: true })).statusCode).toBe(200);
    expect(metaCalls()).toHaveLength(calls);
    expect((await act(rep, id, "hide", { hidden: false })).statusCode).toBe(200);
    expect(ig.hidden.has("C1")).toBe(false);
    expect((await row(id)).hidden).toBe(false);
    const log = await h.queryAll<{ action: string }>(
      "SELECT action FROM audit_log WHERE entity_id = $1 ORDER BY at, id",
      [id],
    );
    expect(log.map((l) => l.action)).toEqual(["instagram.comment_hidden", "instagram.comment_shown"]);
  });

  it("Instagram refusing: LUME never says it's hidden, and says why", async () => {
    const id = await comment();
    ig.commentFail.push(500);
    const r = await act(rep, id, "hide", { hidden: true });
    expect(r.statusCode).toBe(502);
    expect(r.json().error.message).toBe("Instagram didn't answer. Try again.");
    expect((await row(id)).hidden).toBe(false);
    ig.commentFail.push(10);
    const no = await act(rep, id, "hide", { hidden: true });
    expect(no.statusCode).toBe(403);
    expect(no.json().error.message).toBe("Instagram doesn't allow LUME to do that on this account yet.");
    ig.commentFail.push(4);
    expect((await act(rep, id, "hide", { hidden: true })).json().error.code).toBe("INSTAGRAM_BUSY");
    expect((await row(id)).hidden).toBe(false);
  });
});

describe("delete", () => {
  it("deletes on Instagram once; the second press finds it done; it can't be answered or hidden after", async () => {
    const id = await comment();
    const r = await act(rep, id, "delete");
    expect(r.statusCode, r.body).toBe(200);
    expect(ig.deleted.has("C1")).toBe(true);
    expect((await row(id)).deleted_at).not.toBeNull();
    const calls = metaCalls().length;
    expect((await act(rep, id, "delete")).statusCode).toBe(200);
    expect(metaCalls()).toHaveLength(calls);
    expect((await act(rep, id, "hide", { hidden: true })).json().error.code).toBe("COMMENT_DELETED");
    expect((await act(rep, id, "public-reply", { text: "Hi" })).json().error.code).toBe("COMMENT_DELETED");
    const view = (
      await (await h.signIn(rep)).inject({ method: "GET", url: `/api/v1/leads/${leadId}/instagram` })
    ).json();
    expect(view.threads[0].comments[0]).toMatchObject({ deleted: true });
  });

  it("already gone from Instagram (deleted in the app): it's deleted here too", async () => {
    const id = await comment();
    ig.missing.add("C1");
    expect((await act(rep, id, "delete")).statusCode).toBe(200);
    expect((await row(id)).deleted_at).not.toBeNull();
  });

  it("Instagram's generic refusal (code 100) while the comment is still there: never called deleted", async () => {
    const id = await comment();
    ig.commentFail.push(100);
    const r = await act(rep, id, "delete");
    expect(r.statusCode).toBe(409);
    expect(r.json().error.message).toBe("Instagram didn't allow that.");
    expect((await row(id)).deleted_at).toBeNull();
  });

  it("two deletes at once: Instagram is asked once", async () => {
    const id = await comment();
    const [a, b] = await Promise.all([act(rep, id, "delete"), act(rep, id, "delete")]);
    expect([a.statusCode, b.statusCode]).toEqual([200, 200]);
    expect(metaCalls().filter((c) => c.method === "DELETE")).toHaveLength(1);
    const log = await h.queryAll<{ action: string }>("SELECT action FROM audit_log WHERE entity_id = $1", [
      id,
    ]);
    expect(log.map((l) => l.action)).toEqual(["instagram.comment_deleted"]);
  });

  it("Instagram unreachable: nothing changes, and it says so", async () => {
    const id = await comment();
    ig.commentFail.push(503);
    expect((await act(rep, id, "delete")).statusCode).toBe(502);
    expect((await row(id)).deleted_at).toBeNull();
  });
});

describe("who may, and when", () => {
  it("someone who can't see the lead: as if it weren't there; someone who can't send: refused", async () => {
    const id = await comment();
    expect((await act(other, id, "hide", { hidden: true })).statusCode).toBe(404);
    expect((await act(viewer, id, "delete")).statusCode).toBe(403);
    expect(metaCalls()).toEqual([]);
  });

  it("the account's own person, on a lead they can't see: as if it weren't there", async () => {
    const id = await comment();
    await h.ownerPool.query("UPDATE instagram_accounts SET owner_user_id = $1", [other.id]);
    expect((await act(other, id, "delete")).statusCode).toBe(404);
    expect(metaCalls()).toEqual([]);
  });

  it("the account needs connecting again: nothing goes, and it says so", async () => {
    const id = await comment();
    await h.ownerPool.query("UPDATE instagram_accounts SET status = 'needs_attention'");
    expect((await act(rep, id, "delete")).json().error.code).toBe("ACCOUNT_NOT_READY");
    await h.ownerPool.query("UPDATE instagram_accounts SET status = 'active'");
    ig.revoked.add("IGQlong-account-token");
    const r = await act(rep, id, "hide", { hidden: true });
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe("ACCOUNT_NOT_READY");
    // Everywhere in LUME: the account needs connecting again, and the admins hear.
    const [a] = await h.queryAll<{ status: string }>("SELECT status FROM instagram_accounts WHERE id = $1", [
      account.id,
    ]);
    expect(a!.status).toBe("needs_attention");
  });

  it("someone who sees every lead but may message only their own: can't act on another's lead's comment", async () => {
    const seer = await h.seedUser({
      grants: [
        { key: "leads.view", scope: "all" },
        { key: "messages.send", scope: "own" },
      ],
    });
    const id = await comment();
    const r = await act(seer, id, "delete");
    expect(r.statusCode).toBe(403);
    expect(ig.deleted.size).toBe(0);
  });

  it("a comment whose conversation is gone: as if it weren't there, even to someone who sees every lead", async () => {
    const id = await comment();
    await h.queryAll("UPDATE instagram_comments SET thread_id = NULL WHERE id = $1", [id]);
    expect((await act(admin, id, "delete")).statusCode).toBe(404);
    expect(ig.deleted.size).toBe(0);
  });
});
