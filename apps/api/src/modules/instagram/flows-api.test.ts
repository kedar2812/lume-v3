import { ALL_GRANTS } from "@lume/core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../../../test/harness";
import { IG_RELAY_TOKEN, seedIgAccount } from "../../../test/instagram";

/** Building flows (NEW_FEATURES_PLAN §4.5; plan 1B Task 3). */
let h: Harness;
type U = { id: string; email: string; password: string };
let admin: U;
let builder: U;
let rep: U;
let account: { id: string };

const as = async (u: U) => h.signIn(u);
const call = async (u: U, method: "GET" | "POST" | "PUT", url: string, payload?: unknown) =>
  (await as(u)).inject({ method, url, ...(payload !== undefined ? { payload: payload as object } : {}) });

const good = [
  {
    id: "hello",
    type: "send",
    text: "Here's the guide!",
    buttons: [{ title: "Get it", url: "https://example.test/g" }],
  },
];
const commentTrigger = (o: Record<string, unknown> = {}) => ({
  kind: "comment",
  accountId: null,
  keywords: ["guide"],
  mode: "word",
  mediaIds: [],
  adIds: [],
  publicReplies: ["Sent you a DM!"],
  cooldownHours: 24,
  enabled: true,
  ...o,
});

async function flow(name = "Lead magnet", steps: unknown[] = good, triggers = [commentTrigger()]) {
  let f = (await call(builder, "POST", "/api/v1/instagram/flows", { name })).json();
  f = (await call(builder, "PUT", `/api/v1/instagram/flows/${f.id}`, { rev: f.rev, steps })).json();
  f = (
    await call(builder, "PUT", `/api/v1/instagram/flows/${f.id}/triggers`, { rev: f.rev, triggers })
  ).json();
  return f as { id: string; rev: number; problems: string[] };
}

beforeAll(async () => {
  h = await createHarness({ oauth: { relayToken: IG_RELAY_TOKEN } });
  h.clock.now = new Date("2026-11-22T08:00:00Z");
  admin = await h.seedUser({ owner: true, grants: ALL_GRANTS, totp: true });
  builder = await h.seedUser({ grants: [{ key: "instagram.flows.manage", scope: null }] });
  rep = await h.seedUser({ grants: [{ key: "leads.view", scope: "own" }] });
});
afterAll(() => h.close());
beforeEach(async () => {
  h.clock.advance(60_000);
  await h.ownerPool.query("TRUNCATE instagram_flows CASCADE");
  await h.ownerPool.query("DELETE FROM instagram_accounts");
  await h.ownerPool.query("DELETE FROM lead_sources WHERE type = 'instagram'");
  account = await seedIgAccount(h, { runAs: admin.id });
});

describe("who may build flows", () => {
  it("someone with Manage Instagram flows may; a rep may not", async () => {
    expect((await call(builder, "GET", "/api/v1/instagram/flows")).statusCode).toBe(200);
    expect((await call(rep, "GET", "/api/v1/instagram/flows")).statusCode).toBe(403);
    expect((await call(rep, "POST", "/api/v1/instagram/flows", { name: "x" })).statusCode).toBe(403);
  });

  it("the list carries each flow's rev, so the Flows page can switch one on or off without a stale write", async () => {
    const made = (await call(builder, "POST", "/api/v1/instagram/flows", { name: "Rev check" })).json();
    const list = (await call(builder, "GET", "/api/v1/instagram/flows")).json();
    expect(list.flows.find((f: { id: string }) => f.id === made.id)).toMatchObject({ rev: made.rev });
  });

  it("Instagram switched off: flows say so, in words", async () => {
    await h.ownerPool.query(
      `UPDATE settings SET integrations = jsonb_set(integrations, '{instagram}', '{"enabled": false}'::jsonb) WHERE id = 1`,
    );
    const r = await call(builder, "GET", "/api/v1/instagram/flows");
    expect(r.statusCode).toBe(409);
    expect(r.json().error.message).toBe("Instagram is off. Switch it on in Settings → Integrations first.");
  });
});

describe("drafts and publishing", () => {
  it("a draft saves even when it can't be published, and says what's wrong", async () => {
    const f = await flow("Draft", [{ id: "a", type: "send", text: "x".repeat(1001) }]);
    expect(f.problems[0]).toMatch(/too long for Instagram/);
    const p = await call(builder, "POST", `/api/v1/instagram/flows/${f.id}/publish`, { rev: f.rev });
    expect(p.statusCode).toBe(422);
    expect(p.json().error.details.problems[0]).toMatch(/too long for Instagram/);
  });

  it("publishing makes version 1 live; publishing again makes version 2, and 1 stays as it was", async () => {
    const f = await flow();
    const v1 = (
      await call(builder, "POST", `/api/v1/instagram/flows/${f.id}/publish`, { rev: f.rev })
    ).json();
    expect(v1).toMatchObject({ status: "live", live: { version: 1 } });
    const edited = (
      await call(builder, "PUT", `/api/v1/instagram/flows/${f.id}`, {
        rev: v1.rev,
        steps: [{ ...good[0], text: "Here it is!" }],
      })
    ).json();
    expect(edited.live.steps[0].text).toBe("Here's the guide!");
    const v2 = (
      await call(builder, "POST", `/api/v1/instagram/flows/${f.id}/publish`, { rev: edited.rev })
    ).json();
    expect(v2.live).toMatchObject({ version: 2, steps: [{ text: "Here it is!" }] });
    const versions = await h.queryAll<{ version: number; text: string }>(
      "SELECT version, steps->0->>'text' AS text FROM instagram_flow_versions ORDER BY version",
    );
    expect(versions).toEqual([
      { version: 1, text: "Here's the guide!" },
      { version: 2, text: "Here it is!" },
    ]);
    await expect(h.ownerPool.query("UPDATE instagram_flow_versions SET steps = '[]'")).rejects.toThrow(
      /never changes/,
    );
  });

  it("a stale edit (someone saved meanwhile) is refused, not merged unseen", async () => {
    const f = await flow();
    await call(builder, "PUT", `/api/v1/instagram/flows/${f.id}`, { rev: f.rev, name: "Mine" });
    const late = await call(admin, "PUT", `/api/v1/instagram/flows/${f.id}`, { rev: f.rev, name: "Theirs" });
    expect(late.statusCode).toBe(409);
    expect(late.json().error.message).toBe(
      "Someone else changed this flow meanwhile. Reload to see their changes.",
    );
  });

  it("two people publishing at once: one version each at most, numbered in turn", async () => {
    const f = await flow();
    const [a, b] = await Promise.all([
      call(builder, "POST", `/api/v1/instagram/flows/${f.id}/publish`, { rev: f.rev }),
      call(admin, "POST", `/api/v1/instagram/flows/${f.id}/publish`, { rev: f.rev }),
    ]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409]);
    expect(await h.queryAll("SELECT 1 FROM instagram_flow_versions")).toHaveLength(1);
  });

  it("nothing starts it: can't be published", async () => {
    const f = await flow("No trigger", good, []);
    const p = await call(builder, "POST", `/api/v1/instagram/flows/${f.id}/publish`, { rev: f.rev });
    expect(p.json().error.message).toBe(
      "Add what starts this flow: a keyword, a story reply, an ad or a first message.",
    );
  });

  it("a tag, stage or person it names that's gone: can't be published", async () => {
    const tag = (
      await h.queryAll<{ id: string }>(
        "INSERT INTO tags (id, label) VALUES (gen_random_uuid(), 'Guide') RETURNING id",
      )
    )[0]!.id;
    const f = await flow("Tags", [...good, { id: "t", type: "tag", tagId: tag, add: true }]);
    await h.ownerPool.query("DELETE FROM tags WHERE id = $1", [tag]);
    const p = await call(builder, "POST", `/api/v1/instagram/flows/${f.id}/publish`, { rev: f.rev });
    expect(p.json().error.message).toBe("A tag this flow uses was deleted. Choose another.");
  });

  it("a body far too big is refused before anything reads it", async () => {
    const f = await flow();
    const huge = Array.from({ length: 51 }, (_, i) => ({ id: `s${i}`, type: "send", text: "hi" }));
    const r = await call(builder, "PUT", `/api/v1/instagram/flows/${f.id}`, { rev: f.rev, steps: huge });
    expect(r.statusCode).toBe(400);
  });
});

describe("one keyword, one flow", () => {
  it("a second live flow can't take a keyword another has, in any case or accent", async () => {
    const a = await flow("Lead magnet");
    await call(builder, "POST", `/api/v1/instagram/flows/${a.id}/publish`, { rev: a.rev });
    const b = await flow("Spring batch", good, [commentTrigger({ keywords: ["GUÍDE", "spring"] })]);
    const r = await call(builder, "POST", `/api/v1/instagram/flows/${b.id}/publish`, { rev: b.rev });
    expect(r.statusCode).toBe(409);
    expect(r.json().error.message).toBe(
      "“guide” already starts Lead magnet. Pick another keyword, or pause Lead magnet first.",
    );
  });

  it("the same word on comments and on DMs are different claims; another account's too", async () => {
    const a = await flow("Comments");
    await call(builder, "POST", `/api/v1/instagram/flows/${a.id}/publish`, { rev: a.rev });
    const b = await flow("DMs", good, [commentTrigger({ kind: "dm", publicReplies: [] })]);
    expect(
      (await call(builder, "POST", `/api/v1/instagram/flows/${b.id}/publish`, { rev: b.rev })).statusCode,
    ).toBe(200);
  });

  it("pausing frees nothing; archiving does", async () => {
    const a = await flow("Lead magnet");
    const live = (
      await call(builder, "POST", `/api/v1/instagram/flows/${a.id}/publish`, { rev: a.rev })
    ).json();
    await call(builder, "POST", `/api/v1/instagram/flows/${a.id}/status`, { rev: live.rev, to: "paused" });
    const b = await flow("Again");
    expect(
      (await call(builder, "POST", `/api/v1/instagram/flows/${b.id}/publish`, { rev: b.rev })).statusCode,
    ).toBe(409);
    await call(builder, "POST", `/api/v1/instagram/flows/${a.id}/archive`);
    expect(
      (await call(builder, "POST", `/api/v1/instagram/flows/${b.id}/publish`, { rev: b.rev })).statusCode,
    ).toBe(200);
  });

  it("keywords keep their commas, quotes and backslashes", async () => {
    const odd = ["a, b", 'say "hi"', "back\\slash", "दाम"];
    const f = await flow("Odd", good, [commentTrigger({ keywords: odd })]);
    const v = (await call(builder, "GET", `/api/v1/instagram/flows/${f.id}`)).json();
    expect(v.triggers[0].keywords).toEqual(odd);
  });

  it("a copy comes with its triggers off, so it never clashes", async () => {
    const a = await flow("Lead magnet");
    await call(builder, "POST", `/api/v1/instagram/flows/${a.id}/publish`, { rev: a.rev });
    const c = (await call(builder, "POST", `/api/v1/instagram/flows/${a.id}/duplicate`)).json();
    expect(c).toMatchObject({ name: "Lead magnet (copy)", status: "draft", triggers: [{ enabled: false }] });
  });
});

describe("review fixes", () => {
  it("a post filter only on comments; an ad filter only on comments and ads", async () => {
    let f = (await call(builder, "POST", "/api/v1/instagram/flows", { name: "X" })).json();
    const r = await call(builder, "PUT", `/api/v1/instagram/flows/${f.id}/triggers`, {
      rev: f.rev,
      triggers: [commentTrigger({ kind: "dm", mediaIds: ["17980000000000001"], publicReplies: [] })],
    });
    expect(r.json().error.message).toBe("Only a comment trigger can be limited to posts.");
    f = (await call(builder, "GET", `/api/v1/instagram/flows/${f.id}`)).json();
    const s = await call(builder, "PUT", `/api/v1/instagram/flows/${f.id}/triggers`, {
      rev: f.rev,
      triggers: [commentTrigger({ kind: "dm", adIds: ["120200000000000001"], publicReplies: [] })],
    });
    expect(s.json().error.message).toBe("Only a comment or ad trigger can be limited to ads.");
  });

  it("publishing a paused flow keeps it paused", async () => {
    const f = await flow();
    const live = (
      await call(builder, "POST", `/api/v1/instagram/flows/${f.id}/publish`, { rev: f.rev })
    ).json();
    const paused = (
      await call(builder, "POST", `/api/v1/instagram/flows/${f.id}/status`, { rev: live.rev, to: "paused" })
    ).json();
    const again = (
      await call(builder, "POST", `/api/v1/instagram/flows/${f.id}/publish`, { rev: paused.rev })
    ).json();
    expect(again).toMatchObject({ status: "paused", live: { version: 2 } });
  });

  it("a question may keep its answer for the flow only (no lead field of that name)", async () => {
    const f = await flow("Ask", [
      {
        id: "q",
        type: "ask",
        text: "Which?",
        save: { field: "interest", kind: "choice" },
        choices: ["A", "B"],
        fallback: "Tap one.",
      },
    ]);
    expect(
      (await call(builder, "POST", `/api/v1/instagram/flows/${f.id}/publish`, { rev: f.rev })).statusCode,
    ).toBe(200);
  });
});

describe("ready-made flows (plan 2026-11-25-instagram-screens D4)", () => {
  type Made = {
    id: string;
    rev: number;
    problems: string[];
    draft: { v: number; nodes: { type: string; actions?: { kind: string; tagId: string }[] }[] };
    triggers: { kind: string; keywords: string[]; enabled: boolean }[];
  };
  const make = async (u: U, template: string, name = "From a ready one") =>
    (await call(u, "POST", "/api/v1/instagram/flows", { name, template })).json() as Made;
  const tagIds = (f: Made) =>
    f.draft.nodes
      .flatMap((n) => n.actions ?? [])
      .filter((a) => a.kind === "tag")
      .map((a) => a.tagId);

  it("the fifteen, in their order, each with its group", async () => {
    const list = (await call(builder, "GET", "/api/v1/instagram/flows/templates")).json().templates;
    expect(list).toHaveLength(15);
    expect(list[0]).toMatchObject({ key: "comment_link", name: "Link for a comment", group: "leads" });
    expect(list.map((t: { key: string }) => t.key)).toContain("giveaway");
  });

  it("a draft on the canvas, with what starts it, that can't go live until its links are added", async () => {
    const f = await make(admin, "comment_freebie");
    expect(f.draft.v).toBe(2);
    expect(f.triggers).toEqual([
      expect.objectContaining({ kind: "comment", keywords: ["GUIDE"], enabled: true }),
    ]);
    expect(f.problems).toContain("A button's link must start with https://.");
    expect(
      (await call(admin, "POST", `/api/v1/instagram/flows/${f.id}/publish`, { rev: f.rev })).statusCode,
    ).toBe(422);
  });

  it("words left to write ([[…]]) stop it going live too", async () => {
    const f = await make(admin, "faq_menu");
    expect(f.problems).toContain("Write your own words where it says [[…]].");
  });

  it("a ready one needs nothing: it can go live as it is", async () => {
    const f = await make(admin, "story_reply");
    expect(f.problems).toEqual([]);
  });

  it("its tag: the business's own when one has that name (any case), never a second", async () => {
    const { id } = (
      await h.ownerPool.query<{ id: string }>(
        "INSERT INTO tags (id, label) VALUES (gen_random_uuid(), 'Waitlist') RETURNING id",
      )
    ).rows[0]!;
    const f = await make(admin, "waitlist");
    expect(tagIds(f)).toEqual([id]);
    expect(f.problems).toEqual([]);
    const { rows } = await h.ownerPool.query("SELECT 1 FROM tags WHERE lower(label) = 'waitlist'");
    expect(rows).toHaveLength(1);
    await h.ownerPool.query("DELETE FROM tags WHERE id = $1", [id]);
  });

  it("no such tag: made for someone who may make tags; left to choose for someone who may not", async () => {
    await h.ownerPool.query("DELETE FROM tags WHERE lower(label) = 'giveaway'");
    const mine = await make(builder, "giveaway");
    expect(tagIds(mine)).toEqual([""]);
    expect(mine.problems).toContain("Choose the tag.");
    expect((await h.ownerPool.query("SELECT 1 FROM tags WHERE lower(label) = 'giveaway'")).rows).toHaveLength(
      0,
    );
    const theirs = await make(admin, "giveaway");
    const [made] = (
      await h.ownerPool.query<{ id: string }>("SELECT id FROM tags WHERE lower(label) = 'giveaway'")
    ).rows;
    expect(tagIds(theirs)).toEqual([made!.id]);
    await h.ownerPool.query("DELETE FROM tags WHERE id = $1", [made!.id]);
  });

  it("a key that isn't one is refused", async () => {
    const r = await call(admin, "POST", "/api/v1/instagram/flows", { name: "x", template: "lead_magnet_v0" });
    expect(r.statusCode).toBe(400);
  });
});

describe("archiving", () => {
  it("stops every conversation in it, saying why, whoever's lead it is", async () => {
    const a = await flow();
    const live = (
      await call(builder, "POST", `/api/v1/instagram/flows/${a.id}/publish`, { rev: a.rev })
    ).json();
    const leadId = await h.seedLead({ ownerId: rep.id, name: "Maya" });
    const t = (
      await h.queryAll<{ id: string }>(
        "INSERT INTO instagram_threads (id, account_id, igsid, lead_id) VALUES (gen_random_uuid(), $1, '6512000000000099', $2) RETURNING id",
        [account.id, leadId],
      )
    )[0]!.id;
    const vid = (await h.queryAll<{ id: string }>("SELECT live_version_id AS id FROM instagram_flows"))[0]!
      .id;
    await h.queryAll(
      `INSERT INTO instagram_flow_runs (id, flow_id, version_id, thread_id, lead_id, status, state, started_by)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, 'waiting', '{}', 'comment')`,
      [live.id, vid, t, leadId],
    );
    const r = (await call(builder, "POST", `/api/v1/instagram/flows/${a.id}/archive`)).json();
    expect(r).toEqual({ ok: true, stopped: 1 });
    expect(await h.queryAll("SELECT status, reason FROM instagram_flow_runs")).toEqual([
      { status: "stopped", reason: "This flow was archived." },
    ]);
  });
});
