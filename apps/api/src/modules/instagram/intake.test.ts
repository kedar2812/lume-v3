import { randomUUID } from "node:crypto";
import { ALL_GRANTS } from "@lume/core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { igComment, igDm } from "../../../../../packages/core/src/instagram/fixtures";
import { createHarness, type Harness } from "../../../test/harness";
import { deliverIg, IG_RELAY_TOKEN, seedIgAccount } from "../../../test/instagram";
import { fakeAccount, startInstagramFake, type InstagramFake } from "../../../test/instagram-fake";
import { sweepInstagram } from "./inbox";

/**
 * What a stranger on Instagram can make LUME do, bounded (security review 2026-11-23): new leads an hour per account
 * (past that, new people wait in Not a lead yet), megabytes of files a day per person and per account, comments that
 * never became a conversation swept, each account's limits its own.
 */
const HOUR = 3_600_000;
const MB = 1024 * 1024;
let h: Harness;
let ig: InstagramFake;
let admin: { id: string; email: string; password: string };
let account: { id: string; sourceId: string };
let n = 0;

const person = (i: number) => String(6512000000001000 + i);
const dm = async (from: string, extra: Record<string, unknown> = {}) => {
  const r = await deliverIg(h, igDm({ mid: `m${++n}`, from, at: h.clock.now.toISOString(), ...extra }));
  expect(r.statusCode).toBe(200);
  await h.runInstagram();
};
const leads = () => h.queryAll<{ id: string }>("SELECT id FROM leads WHERE deleted_at IS NULL");
/** What the admin was told, as they read it (notifications are each person's own). */
const told = async (start: string) =>
  (
    (await (await h.signIn(admin)).inject({ method: "GET", url: "/api/v1/notifications" })).json().items as {
      title: string;
      body: string;
    }[]
  ).filter((n) => n.title.startsWith(start));
const waiting = () =>
  h.queryAll<{ igsid: string }>(
    "SELECT DISTINCT t.igsid FROM instagram_inbox i JOIN instagram_threads t ON t.id = i.thread_id",
  );
/** The account's limits for a test; any not given stay as they are. */
const limits = (set: {
  new_leads_per_hour?: number;
  media_mb_per_person_day?: number;
  media_mb_per_day?: number;
}) =>
  h.ownerPool.query(
    `UPDATE instagram_accounts SET new_leads_per_hour = coalesce($1, new_leads_per_hour),
            media_mb_per_person_day = coalesce($2, media_mb_per_person_day),
            media_mb_per_day = coalesce($3, media_mb_per_day)`,
    [set.new_leads_per_hour ?? null, set.media_mb_per_person_day ?? null, set.media_mb_per_day ?? null],
  );
const file = (name: string, bytes: number) => {
  ig.files.set(name, { type: "image/jpeg", bytes: Buffer.alloc(bytes, name.length) });
  return [{ type: "image", payload: { url: `${ig.graphUrl}/cdn/${name}` } }];
};
const media = () =>
  h.queryAll<{ status: string; problem: string | null }>(
    "SELECT status, problem FROM instagram_media ORDER BY created_at, position",
  );

beforeAll(async () => {
  ig = await startInstagramFake();
  h = await createHarness({
    oauth: { relayToken: IG_RELAY_TOKEN },
    instagramGraph: { graphUrl: ig.graphUrl, version: ig.version },
  });
  h.setRelayUrl("https://relay.test");
  h.clock.now = new Date("2026-11-22T06:00:00Z");
  admin = await h.seedUser({ owner: true, grants: ALL_GRANTS, totp: true });
});
afterAll(async () => {
  await h.close();
  await ig.close();
});
beforeEach(async () => {
  h.clock.advance(3 * 86_400_000);
  await h.ownerPool.query(
    `TRUNCATE leads, activities, instagram_threads, instagram_events, instagram_comments, instagram_outbox,
              instagram_budgets, instagram_flows, whatsapp_files, notifications CASCADE`,
  );
  await h.ownerPool.query("DELETE FROM instagram_accounts");
  await h.ownerPool.query("DELETE FROM lead_sources WHERE type = 'instagram'");
  h.instagramQueued.length = 0;
  h.instagramMediaQueued.length = 0;
  ig.files.clear();
  ig.profiles.clear();
  ig.tokens.clear();
  ig.tokens.set("IGQlong-account-token", fakeAccount());
  account = await seedIgAccount(h, { runAs: admin.id });
});

describe("new leads an hour", () => {
  it("past the account's limit new people wait in Not a lead yet; the next hour has room again", async () => {
    await limits({ new_leads_per_hour: 2 });
    for (const i of [1, 2, 3]) await dm(person(i));
    expect(await leads()).toHaveLength(2);
    expect((await waiting()).map((w) => w.igsid)).toEqual([person(3)]);
    // Someone already a lead keeps writing to it: the limit is on new ones only.
    await dm(person(1));
    expect(await leads()).toHaveLength(2);
    h.clock.advance(HOUR);
    await dm(person(4));
    expect(await leads()).toHaveLength(3);
  });

  it("the admins hear once an hour that new people were turned away, however many were", async () => {
    await limits({ new_leads_per_hour: 1 });
    for (const i of [1, 2, 3]) await dm(person(i));
    const once = await told("Instagram: more new people");
    expect(once).toHaveLength(1);
    expect(once[0]!.body).toContain("Not a lead yet");
    h.clock.advance(HOUR);
    await limits({ new_leads_per_hour: 1 });
    for (const i of [4, 5]) await dm(person(i));
    expect(await told("Instagram: more new people")).toHaveLength(2);
  });

  it("a lead that couldn't be made (no open stage to put it in) gives its place this hour back", async () => {
    await limits({ new_leads_per_hour: 1 });
    await h.ownerPool.query(
      "UPDATE stages SET archived_at = now() WHERE archived_at IS NULL AND kind = 'open'",
    );
    try {
      await dm(person(1));
    } finally {
      await h.ownerPool.query("UPDATE stages SET archived_at = NULL WHERE kind = 'open'");
    }
    expect(await leads()).toHaveLength(0);
    await dm(person(2));
    expect(await leads()).toHaveLength(1);
  });

  it("a comment that would start a flow for a new person past the limit starts nothing; the comment is kept", async () => {
    const flow = randomUUID();
    const v = randomUUID();
    const steps = JSON.stringify([{ id: "hello", type: "send", text: "Here's the guide!" }]);
    await h.ownerPool.query(
      "INSERT INTO instagram_flows (id, name, status, priority, draft_steps, created_by) VALUES ($1, 'Guide', 'draft', 0, $2, $3)",
      [flow, steps, admin.id],
    );
    await h.ownerPool.query(
      "INSERT INTO instagram_flow_versions (id, flow_id, version, steps, created_by) VALUES ($1, $2, 1, $3, $4)",
      [v, flow, steps, admin.id],
    );
    await h.ownerPool.query(
      "UPDATE instagram_flows SET status = 'live', live_version_id = $2 WHERE id = $1",
      [flow, v],
    );
    await h.ownerPool.query(
      `INSERT INTO instagram_triggers (id, flow_id, kind, keywords, mode, media_ids, public_replies, cooldown_hours)
       VALUES ($1, $2, 'comment', '{guide}', 'word', '{}', '{}', 24)`,
      [randomUUID(), flow],
    );
    await limits({ new_leads_per_hour: 1 });
    const at = Math.floor(h.clock.now.getTime() / 1000);
    for (const i of [1, 2]) {
      const r = await deliverIg(h, igComment({ id: `1799000000000${i}`, from: person(i), time: at }));
      expect(r.statusCode).toBe(200);
    }
    await h.runInstagram();
    expect(await leads()).toHaveLength(1);
    expect(await h.queryAll("SELECT 1 FROM instagram_flow_runs")).toHaveLength(1);
    expect(await h.queryAll("SELECT 1 FROM instagram_comments")).toHaveLength(2);
  });
});

describe("files a day", () => {
  it("one person's files past their limit aren't fetched, and say why; another person still gets theirs", async () => {
    await limits({ media_mb_per_person_day: 1 });
    await dm(person(1), { text: undefined, attachments: file("a.jpg", 600_000) });
    await dm(person(1), { text: undefined, attachments: file("b.jpg", 600_000) });
    await dm(person(2), { text: undefined, attachments: file("c.jpg", 600_000) });
    await h.runInstagramMedia();
    const m = await media();
    expect(m.map((x) => x.status)).toEqual(["ready", "over_limit", "ready"]);
    expect(m[1]!.problem).toContain("limit");
    // Exactly at the limit is within it; once reached, the next one isn't even fetched.
    await dm(person(1), { text: undefined, attachments: file("d.jpg", MB - 600_000) });
    await dm(person(1), { text: undefined, attachments: file("e.jpg", 10) });
    await h.runInstagramMedia();
    expect((await media()).slice(3).map((x) => x.status)).toEqual(["ready", "over_limit"]);
    expect(ig.calls.filter((c) => c.path === "/cdn/d.jpg")).toHaveLength(1);
    expect(ig.calls.filter((c) => c.path === "/cdn/e.jpg")).toHaveLength(0);
    // Tomorrow has room again.
    h.clock.advance(86_400_000);
    await dm(person(1), { text: undefined, attachments: file("f.jpg", 600_000) });
    await h.runInstagramMedia();
    expect((await media()).at(-1)!.status).toBe("ready");
  });

  it("a file whose save failed counts once when it's fetched again; the admins hear once a day of the limit", async () => {
    await limits({ media_mb_per_person_day: 1 });
    await dm(person(1), { text: undefined, attachments: file("a.jpg", 600_000) });
    const put = h.files.store.put;
    h.files.store.put = async () => {
      throw Object.assign(new Error("full"), { code: "ENOSPC" });
    };
    try {
      await h.runInstagramMedia();
    } finally {
      h.files.store.put = put;
    }
    expect((await media())[0]!.status).toBe("waiting");
    const id = (await h.queryAll<{ id: string }>("SELECT id FROM instagram_media"))[0]!.id;
    h.clock.advance(20 * 60_000);
    h.instagramMediaQueued.push(id);
    await h.runInstagramMedia();
    expect((await media())[0]!.status).toBe("ready");
    const t = (await h.queryAll<{ id: string }>("SELECT id FROM instagram_threads"))[0]!;
    const spent = await h.queryAll<{ used: string }>("SELECT used FROM instagram_budgets WHERE key = $1", [
      `media:${t.id}`,
    ]);
    expect(spent.map((x) => Number(x.used))).toEqual([600_000]);
    for (const name of ["b.jpg", "c.jpg"])
      await dm(person(1), { text: undefined, attachments: file(name, 600_000) });
    await h.runInstagramMedia();
    expect(await told("Instagram: today")).toHaveLength(1);
  });

  it("the account's limit holds across everyone; a file that's refused counts nothing", async () => {
    await limits({ media_mb_per_day: 1 });
    await dm(person(1), { text: undefined, attachments: file("a.jpg", 700_000) });
    await dm(person(2), { text: undefined, attachments: file("b.jpg", 700_000) });
    await dm(person(3), { text: undefined, attachments: file("c.jpg", 200_000) });
    await h.runInstagramMedia();
    expect((await media()).map((x) => x.status)).toEqual(["ready", "over_limit", "ready"]);
    const used = await h.queryAll<{ key: string; used: string }>(
      "SELECT key, used FROM instagram_budgets WHERE key LIKE 'media:%' ORDER BY used DESC",
    );
    expect(Number(used.find((u) => u.key === `media:${account.id}`)!.used)).toBe(900_000);
    // The refused file counted for nobody: not for its sender either (both limits, or neither).
    const threads = await h.queryAll<{ id: string; igsid: string }>(
      "SELECT id, igsid FROM instagram_threads",
    );
    const second = threads.find((t) => t.igsid === person(2))!;
    expect(used.find((u) => u.key === `media:${second.id}`)).toBeUndefined();
  });
});

describe("comments and counts don't pile up", () => {
  it("the sweep drops comments that never became a conversation after 30 days, and old counts; keeps the rest", async () => {
    await dm(person(1));
    const t = (await h.queryAll<{ id: string }>("SELECT id FROM instagram_threads"))[0]!;
    for (const [id, thread, state] of [
      ["c-old", null, "none"],
      ["c-old-queued", null, "queued"],
      ["c-old-threaded", t.id, "sent"],
      ["c-new", null, "none"],
    ] as const)
      await h.queryAll(
        `INSERT INTO instagram_comments (id, account_id, comment_id, from_igsid, at, thread_id, private_reply, created_at)
         VALUES ($1, $2, $3, $4, now(), $5, $6, CASE WHEN $7 THEN now() ELSE now() - interval '31 days' END)`,
        [randomUUID(), account.id, id, person(9), thread, state, id === "c-new"],
      );
    await h.ownerPool.query(
      "INSERT INTO instagram_budgets (key, window_start, used) VALUES ('lead:x', now() - interval '3 days', 5), ('lead:y', now(), 1)",
    );
    await sweepInstagram(h.ownerPool);
    const left = await h.queryAll<{ comment_id: string }>(
      "SELECT comment_id FROM instagram_comments ORDER BY comment_id",
    );
    expect(left.map((c) => c.comment_id)).toEqual(["c-new", "c-old-queued", "c-old-threaded"]);
    expect(
      (await h.queryAll<{ key: string }>("SELECT key FROM instagram_budgets WHERE key LIKE 'lead:_'")).map(
        (b) => b.key,
      ),
    ).toEqual(["lead:y"]);
  });

  it("disconnecting drops the account's comments by people who never became a conversation", async () => {
    await dm(person(1));
    const t = (await h.queryAll<{ id: string }>("SELECT id FROM instagram_threads"))[0]!;
    for (const [id, thread] of [
      ["c1", null],
      ["c2", t.id],
    ] as const)
      await h.queryAll(
        `INSERT INTO instagram_comments (id, account_id, comment_id, from_igsid, at, thread_id)
         VALUES ($1, $2, $3, $4, now(), $5)`,
        [randomUUID(), account.id, id, person(9), thread],
      );
    const r = await (
      await h.signIn(admin)
    ).inject({ method: "DELETE", url: `/api/v1/instagram/accounts/${account.id}` });
    expect(r.statusCode).toBe(200);
    expect(
      (await h.queryAll<{ comment_id: string }>("SELECT comment_id FROM instagram_comments")).map(
        (c) => c.comment_id,
      ),
    ).toEqual(["c2"]);
  });
});

describe("each account's limits are its own (Settings)", () => {
  it("shown with the account, changed within bounds, audited; outside the bounds refused", async () => {
    const c = await h.signIn(admin);
    const shown = (await c.inject({ method: "GET", url: "/api/v1/instagram/accounts" })).json().accounts[0];
    expect(shown.limits).toEqual({ newLeadsPerHour: 1000, mediaMbPerPersonDay: 200, mediaMbPerDay: 5000 });
    const set = await c.inject({
      method: "PATCH",
      url: `/api/v1/instagram/accounts/${account.id}`,
      payload: { limits: { newLeadsPerHour: 50 } },
    });
    expect(set.statusCode).toBe(200);
    expect(set.json().accounts[0].limits).toEqual({
      newLeadsPerHour: 50,
      mediaMbPerPersonDay: 200,
      mediaMbPerDay: 5000,
    });
    const audit = await h.queryAll<{ diff: Record<string, unknown> }>(
      "SELECT diff FROM audit_log WHERE action = 'instagram.updated' ORDER BY id DESC LIMIT 1",
    );
    expect(audit[0]!.diff).toEqual({ newLeadsPerHour: { from: 1000, to: 50 } });
    for (const bad of [
      { newLeadsPerHour: 0 },
      { mediaMbPerDay: 2_000_000 },
      { newLeadsPerHour: 1.5 },
      { other: 1 },
      {},
    ])
      expect(
        (
          await c.inject({
            method: "PATCH",
            url: `/api/v1/instagram/accounts/${account.id}`,
            payload: { limits: bad },
          })
        ).statusCode,
      ).toBe(400);
  });
});
