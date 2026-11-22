import { describe, expect, it } from "vitest";
import {
  COMMENT_ID,
  IG_ACCOUNT,
  IG_ACCOUNT_B,
  IGSID,
  MEDIA_ID,
  igAdComment,
  igAdDm,
  igBatch,
  igComment,
  igDm,
  igEcho,
  igEnvelope,
  igPhoto,
  igPostback,
  igQuickReply,
  igReaction,
  igReferral,
  igSeen,
  igStoryMention,
  igStoryReply,
  igUnsend,
} from "./fixtures";
import { eventKey, readInstagramWebhook } from "./webhook";

/** Meta's Instagram deliveries as LUME reads them (NEW_FEATURES_PLAN §4.3; plan 1A Task 1). */
describe("reading Meta's Instagram webhooks", () => {
  it("a DM: which account, from whom, when, and what they said", () => {
    expect(readInstagramWebhook(igDm())).toEqual([
      {
        kind: "message",
        accountId: IG_ACCOUNT,
        igsid: IGSID,
        mid: "aWdfMID1",
        at: "2026-11-22T06:00:00.000Z",
        text: "Hi, is the course still open?",
        attachments: [],
        replyToStory: null,
        storyMention: null,
        quickReply: null,
        referral: null,
        isEcho: false,
      },
    ]);
  });

  it("an echo is the business's own message, and the person is its recipient", () => {
    const [e] = readInstagramWebhook(igEcho());
    expect(e).toMatchObject({
      kind: "message",
      isEcho: true,
      igsid: IGSID,
      accountId: IG_ACCOUNT,
      text: "Yes it is!",
    });
  });

  it("a story reply keeps the story, a story mention keeps its link", () => {
    expect(readInstagramWebhook(igStoryReply())[0]).toMatchObject({
      text: "Love this!",
      replyToStory: { id: "17900000000000001", url: expect.stringContaining("asset_id=1") },
    });
    expect(readInstagramWebhook(igStoryMention())[0]).toMatchObject({
      text: null,
      storyMention: { url: expect.stringContaining("asset_id=2") },
      attachments: [{ type: "story_mention", url: expect.stringContaining("asset_id=2") }],
    });
  });

  it("a photo keeps its attachment", () => {
    expect(readInstagramWebhook(igPhoto())[0]).toMatchObject({
      text: null,
      attachments: [{ type: "image", url: expect.stringContaining("asset_id=3") }],
    });
  });

  it("a first message after an ad click carries the ad", () => {
    expect(readInstagramWebhook(igAdDm())[0]).toMatchObject({
      referral: {
        source: "ADS",
        type: "OPEN_THREAD",
        adId: "120200000000000001",
        ref: "spring",
        adTitle: "Spring batch",
      },
    });
  });

  it("a quick reply tap carries its payload", () => {
    expect(readInstagramWebhook(igQuickReply())[0]).toMatchObject({
      text: "Send me the guide",
      quickReply: "step:2:guide",
    });
  });

  it("a postback, a referral, a reaction and a read each become their own event", () => {
    expect(readInstagramWebhook(igPostback())).toEqual([
      {
        kind: "postback",
        accountId: IG_ACCOUNT,
        igsid: IGSID,
        mid: "aWdfPB1",
        at: "2026-11-22T06:01:00.000Z",
        title: "Book a call",
        payload: "step:3:book",
        referral: null,
      },
    ]);
    expect(readInstagramWebhook(igReferral())[0]).toMatchObject({
      kind: "referral",
      igsid: IGSID,
      referral: { source: "SHORTLINK", ref: "bio", adId: null },
    });
    expect(readInstagramWebhook(igReaction())[0]).toMatchObject({
      kind: "reaction",
      mid: "aWdfECHO1",
      action: "react",
      emoji: "❤️",
    });
    expect(readInstagramWebhook(igReaction("unreact"))[0]).toMatchObject({ action: "unreact", emoji: null });
    expect(readInstagramWebhook(igSeen())[0]).toMatchObject({ kind: "seen", mid: "aWdfECHO1", igsid: IGSID });
  });

  it("a message the person took back is an unsend", () => {
    expect(readInstagramWebhook(igUnsend())).toEqual([
      {
        kind: "unsend",
        accountId: IG_ACCOUNT,
        igsid: IGSID,
        mid: "aWdfMID1",
        at: "2026-11-22T06:00:00.000Z",
      },
    ]);
  });

  it("a comment: post, author, words, and no ad", () => {
    expect(readInstagramWebhook(igComment())).toEqual([
      {
        kind: "comment",
        accountId: IG_ACCOUNT,
        commentId: COMMENT_ID,
        mediaId: MEDIA_ID,
        mediaType: "REELS",
        parentId: null,
        fromIgsid: IGSID,
        fromUsername: "priya.fit",
        text: "GUIDE please",
        at: "2026-11-22T06:00:00.000Z",
        adId: null,
        live: false,
      },
    ]);
  });

  it("a comment on an ad keeps the ad; a live comment is marked live; a reply keeps its parent", () => {
    expect(readInstagramWebhook(igAdComment())[0]).toMatchObject({ adId: "120200000000000002" });
    expect(readInstagramWebhook(igComment({ field: "live_comments" }))[0]).toMatchObject({ live: true });
    expect(readInstagramWebhook(igComment({ parent: "17990000000000009" }))[0]).toMatchObject({
      parentId: "17990000000000009",
    });
  });

  it("a comment's id may come as comment_id", () => {
    const body = igComment();
    const value = body.entry[0]!.changes[0]!.value as Record<string, unknown>;
    delete value.id;
    value.comment_id = "17990000000000003";
    expect(readInstagramWebhook(body)[0]).toMatchObject({ commentId: "17990000000000003" });
  });

  it("each account in a batch keeps its own id", () => {
    expect(readInstagramWebhook(igBatch()).map((e) => e.accountId)).toEqual([IG_ACCOUNT, IG_ACCOUNT_B]);
  });

  it("anything it can't read is dropped, never thrown", () => {
    for (const body of [{}, null, "x", 42, { object: "instagram" }, { object: "instagram", entry: "no" }])
      expect(readInstagramWebhook(body)).toEqual([]);
    expect(readInstagramWebhook({ object: "page", entry: igDm().entry })).toEqual([]);
    expect(readInstagramWebhook({ object: "instagram", entry: [{ id: IG_ACCOUNT, time: 1 }] })).toEqual([]);
    const mixed = igEnvelope([{ nonsense: true }, igDm().entry[0]!.messaging[0]!]);
    expect(readInstagramWebhook(mixed)).toHaveLength(1);
    expect(readInstagramWebhook(igComment({ field: "story_insights" }))).toEqual([]);
  });

  it("long words are kept whole; LUME limits only what it sends", () => {
    const text = "a".repeat(5000);
    expect(readInstagramWebhook(igDm({ text }))[0]).toMatchObject({ text });
  });

  it("an attachment type LUME doesn't know is kept as unsupported", () => {
    const [e] = readInstagramWebhook(
      igDm({ text: undefined, attachments: [{ type: "hologram", payload: { url: "https://x.test/a" } }] }),
    );
    expect(e).toMatchObject({ attachments: [{ type: "unsupported", url: null }] });
  });

  it("comment times in seconds and messaging times in milliseconds both read as the same moment", () => {
    const c = readInstagramWebhook(igComment())[0]!;
    const m = readInstagramWebhook(igDm())[0]!;
    expect(c.at).toBe(m.at);
  });
});

describe("the key that keeps each delivery once", () => {
  const key = (body: unknown) => eventKey(readInstagramWebhook(body)[0]!);
  it("differs by kind and by what happened", () => {
    const keys = [
      key(igDm()),
      key(igPostback()),
      key(igReaction("react")),
      key(igReaction("unreact")),
      key(igSeen()),
      key(igComment()),
      key(igReferral()),
      key(igUnsend()),
    ];
    expect(new Set(keys).size).toBe(keys.length);
  });
  it("is the same for the same delivery twice", () => {
    expect(key(igDm())).toBe(key(igDm()));
    expect(key(igComment())).toBe(key(igComment()));
  });
  it("fits a database key (no more than 200 characters)", () => {
    expect(key(igDm({ mid: "m".repeat(500) })).length).toBeLessThanOrEqual(200);
  });
});
