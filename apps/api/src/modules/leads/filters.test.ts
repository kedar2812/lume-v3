import { ALL_GRANTS, newId } from "@lume/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyRequest } from "fastify";
import { createHarness, type AuthedClient, type Harness } from "../../../test/harness";
import { drizzle } from "drizzle-orm/node-postgres";
import { schema as dbSchema } from "@lume/db";
import { scopeCondition, setSearchCapForTests, tagsFor } from "./query";

// 4B Task 1: the filters saved views need — no reply for days, lost a while ago, overdue follow-ups,
// new today (in the business's timezone).
let h: Harness;
let admin: AuthedClient;
let rep: AuthedClient;
let adminId: string;
let repId: string;

beforeAll(async () => {
  h = await createHarness({ preset: "coaching" });
  const a = await h.seedUser({ grants: ALL_GRANTS, totp: true });
  adminId = a.id;
  admin = await h.signIn(a);
  const r = await h.seedUser({
    grants: [{ key: "leads.view", scope: "own" }],
    totp: true,
  });
  repId = r.id;
  rep = await h.signIn(r);
});
afterAll(() => h.close());

const names = async (c: AuthedClient, query: string) => {
  const r = await c.inject({ method: "GET", url: `/api/v1/leads?limit=100&${query}` });
  expect(r.statusCode, r.body).toBe(200);
  return (r.json().items as { name: string }[]).map((l) => l.name).sort();
};
const set = (id: string, sql: string, params: unknown[] = []) =>
  h.queryAll(`UPDATE leads SET ${sql} WHERE id = $1`, [id, ...params]);
const days = (n: number) => new Date(Date.now() - n * 86_400_000);
const overdueTask = async (leadId: string, assignee: string, status = "open") =>
  h.queryAll(
    `INSERT INTO tasks (id, lead_id, assignee_id, title, due_at, status, series_id)
     VALUES ($1, $2, $3, 'Chase', now() - interval '2 hours', $4, $1)`,
    [newId(), leadId, assignee, status],
  );

describe("the leads filters for saved views (4B Task 1)", () => {
  it("no reply for N days: messaged that long ago, not answered since, and still open", async () => {
    const quiet = await h.seedLead({ ownerId: adminId, name: "NR Quiet" });
    await set(quiet, "last_message_at = $2", [days(4)]);
    const recent = await h.seedLead({ ownerId: adminId, name: "NR Recent" });
    await set(recent, "last_message_at = $2", [days(1)]);
    const answered = await h.seedLead({ ownerId: adminId, name: "NR Answered" });
    await set(answered, "last_message_at = $2, last_reply_at = $3", [days(5), days(4)]);
    const answeredBefore = await h.seedLead({ ownerId: adminId, name: "NR Replied Earlier" });
    await set(answeredBefore, "last_message_at = $2, last_reply_at = $3", [days(4), days(6)]);
    const lost = await h.seedLead({ ownerId: adminId, name: "NR Lost", stage: "Lost" });
    await set(lost, "last_message_at = $2", [days(9)]);
    const all = await names(admin, "noReplyDays=3");
    expect(all.filter((n) => n.startsWith("NR "))).toEqual(["NR Quiet", "NR Replied Earlier"]);
  });

  it("lost N+ days ago, and lost for a reason", async () => {
    const [r1, r2] = await h.queryAll<{ id: string }>(
      "SELECT id FROM lost_reasons ORDER BY position LIMIT 2",
    );
    const ten = await h.seedLead({ ownerId: adminId, name: "LD Ten", stage: "Lost" });
    await set(ten, "lost_at = $2, lost_reason_id = $3", [days(10), r1!.id]);
    const forty = await h.seedLead({ ownerId: adminId, name: "LD Forty", stage: "Lost" });
    await set(forty, "lost_at = $2, lost_reason_id = $3", [days(40), r2!.id]);
    const open = await h.seedLead({ ownerId: adminId, name: "LD Open" });
    await set(open, "lost_at = $2", [days(40)]); // an old loss, since reopened: not lost now
    const ld = (xs: string[]) => xs.filter((n) => n.startsWith("LD "));
    expect(ld(await names(admin, "lostDaysAgo=7"))).toEqual(["LD Forty", "LD Ten"]);
    expect(ld(await names(admin, "lostDaysAgo=30"))).toEqual(["LD Forty"]);
    expect(ld(await names(admin, `lostReasonId=${r1!.id}`))).toEqual(["LD Ten"]);
  });

  it("an overdue follow-up: open and past due only; a rep counts only their own", async () => {
    const mine = await h.seedLead({ ownerId: repId, name: "OD Rep Overdue" });
    await overdueTask(mine, repId);
    const other = await h.seedLead({ ownerId: adminId, name: "OD Admin Overdue" });
    await overdueTask(other, adminId);
    const done = await h.seedLead({ ownerId: adminId, name: "OD Done" });
    await overdueTask(done, adminId, "done");
    const od = (xs: string[]) => xs.filter((n) => n.startsWith("OD "));
    expect(od(await names(admin, "followUpOverdue=true"))).toEqual(["OD Admin Overdue", "OD Rep Overdue"]);
    expect(od(await names(rep, "followUpOverdue=true"))).toEqual(["OD Rep Overdue"]);
  });

  it("Review Focus 5: new today is today in the business's timezone, not the server's", async () => {
    await h.queryAll("UPDATE settings SET timezone = 'Pacific/Auckland'");
    try {
      // Arrived in LUME at 23:30 yesterday and 00:30 today, Auckland time; and one with an enquiry date
      // (from a sheet) of today there, which counts by that date.
      const startLocal = `(date_trunc('day', now() AT TIME ZONE 'Pacific/Auckland') AT TIME ZONE 'Pacific/Auckland')`;
      const late = await h.seedLead({ ownerId: adminId, name: "ND Yesterday 23:30" });
      await h.queryAll(`UPDATE leads SET created_at = ${startLocal} - interval '30 minutes' WHERE id = $1`, [
        late,
      ]);
      const early = await h.seedLead({ ownerId: adminId, name: "ND Today 00:30" });
      await h.queryAll(`UPDATE leads SET created_at = ${startLocal} + interval '30 minutes' WHERE id = $1`, [
        early,
      ]);
      const dated = await h.seedLead({ ownerId: adminId, name: "ND Enquired today" });
      await h.queryAll(
        `UPDATE leads SET created_at = now() - interval '20 days',
           lead_created_at = (now() AT TIME ZONE 'Pacific/Auckland')::date WHERE id = $1`,
        [dated],
      );
      const nd = (xs: string[]) => xs.filter((n) => n.startsWith("ND "));
      expect(nd(await names(admin, "createdDays=1"))).toEqual(["ND Enquired today", "ND Today 00:30"]);
      expect(nd(await names(admin, "createdDays=2"))).toEqual([
        "ND Enquired today",
        "ND Today 00:30",
        "ND Yesterday 23:30",
      ]);
    } finally {
      await h.queryAll("UPDATE settings SET timezone = 'Asia/Dubai'");
    }
  });

  it("refuses values that make no sense, in words", async () => {
    for (const q of ["noReplyDays=0", "createdDays=400", "lostReasonId=nope", "lostDaysAgo=-1"]) {
      const r = await admin.inject({ method: "GET", url: `/api/v1/leads?${q}` });
      expect(r.statusCode, q).toBe(400);
    }
  });
});

describe("7A: the person's scope as a plain condition (it never shows more, or less, than row-level security)", () => {
  const ids = async (c: AuthedClient, query = "") => {
    const r = await c.inject({ method: "GET", url: `/api/v1/leads?limit=100&q=Qzx&${query}` });
    expect(r.statusCode, r.body).toBe(200);
    return (r.json().items as { id: string }[]).map((l) => l.id).sort();
  };
  const total = async (c: AuthedClient, query = "") => {
    const cfg = await h.config();
    const r = await c.inject({
      method: "GET",
      url: `/api/v1/leads/counts?pipelineId=${cfg.pipelineId}&q=Qzx&${query}`,
    });
    expect(r.statusCode, r.body).toBe(200);
    return r.json().total as number;
  };
  const view = (scope: "own" | "team") => [
    { key: "leads.view" as const, scope },
    { key: "leads.export" as const, scope: null },
  ];

  it("own, team, an empty team, and all: each sees exactly its leads; filters can narrow, never widen (Review Focus 4)", async () => {
    const own = await h.seedUser({ grants: view("own"), totp: true });
    const mate = await h.seedUser({ grants: view("own") });
    const lone = await h.seedUser({ grants: view("team"), totp: true }); // leads a team, but nobody in it
    const leader = await h.seedUser({ grants: view("team"), totp: true });
    const outsider = await h.seedUser({ grants: view("own") });
    await h.seedTeam(leader.id, [mate.id]);
    await h.seedTeam(lone.id, []);
    const L = {
      own: await h.seedLead({ ownerId: own.id, name: "Qzx Own" }),
      mate: await h.seedLead({ ownerId: mate.id, name: "Qzx Mate" }),
      leader: await h.seedLead({ ownerId: leader.id, name: "Qzx Leader" }),
      lone: await h.seedLead({ ownerId: lone.id, name: "Qzx Lone" }),
      outsider: await h.seedLead({ ownerId: outsider.id, name: "Qzx Outsider" }),
      none: await h.seedLead({ ownerId: null, name: "Qzx Unassigned" }),
    };
    const c = {
      own: await h.signIn(own),
      lone: await h.signIn(lone),
      leader: await h.signIn(leader),
    };
    expect(await ids(c.own)).toEqual([L.own]);
    expect(await ids(c.leader)).toEqual([L.leader, L.mate].sort());
    expect(await ids(c.lone)).toEqual([L.lone]);
    expect(await ids(admin)).toEqual(Object.values(L).sort());
    // Asking for someone outside the scope, or for unassigned leads, finds nothing; "me" is just their own.
    expect(await ids(c.own, `ownerId=${outsider.id}`)).toEqual([]);
    expect(await ids(c.own, "ownerId=none")).toEqual([]);
    expect(await ids(c.leader, `ownerId=${outsider.id}`)).toEqual([]);
    expect(await ids(c.leader, `ownerId=${mate.id}`)).toEqual([L.mate]);
    expect(await ids(c.leader, "ownerId=me")).toEqual([L.leader]);
    expect(await ids(admin, "ownerId=none")).toEqual([L.none]);
    // The counts and the export agree with the list.
    expect(await total(c.own)).toBe(1);
    expect(await total(c.leader)).toBe(2);
    expect(await total(c.lone)).toBe(1);
    expect(await total(admin)).toBe(6);
    const made = await c.leader.inject({
      method: "POST",
      url: "/api/v1/leads/export",
      payload: { format: "csv", label: "Team", filters: { q: "Qzx" }, columns: ["name"] },
    });
    expect(made.statusCode, made.body).toBe(201);
    expect(made.json().export.rows).toBe(2);
  });

  it("the condition itself: own names the person, team adds the team (once each), all adds nothing, no grant is own", async () => {
    const actor = (over: Record<string, unknown>) =>
      ({
        actor: { userId: "u-me", teamMemberIds: [], perms: new Map(), isOwner: false, ...over },
      }) as unknown as FastifyRequest;
    expect(scopeCondition(actor({ perms: new Map([["leads.view", "all"]]) }))).toBeUndefined();
    expect(scopeCondition(actor({ perms: new Map([["leads.view", "own"]]) }))).toBeDefined();
    expect(scopeCondition(actor({ perms: new Map() }))).toBeDefined();
    expect(
      scopeCondition(actor({ perms: new Map([["leads.view", "team"]]), teamMemberIds: ["u-me", "u-a"] })),
    ).toBeDefined();
  });
});

describe("7A: the tag filter, through lead_tags' tag index", () => {
  it("follows every way a tag comes and goes: an edit, bulk add, bulk remove, a tag deleted, a lead deleted", async () => {
    const tag = async (label: string) =>
      (await admin.inject({ method: "POST", url: "/api/v1/tags", payload: { label } })).json().tag
        .id as string;
    const [hot, cold] = [await tag(`Hot ${newId().slice(-6)}`), await tag(`Cold ${newId().slice(-6)}`)];
    const one = await h.seedLead({ ownerId: adminId, name: "TG One" });
    const two = await h.seedLead({ ownerId: adminId, name: "TG Two" });
    const tagged = async (t: string) => names(admin, `tagId=${t}`);
    expect(await tagged(hot)).toEqual([]);
    // An edit sets the lead's tags.
    const edit = await admin.inject({
      method: "PATCH",
      url: `/api/v1/leads/${one}`,
      headers: { "if-match": "1" },
      payload: { tagIds: [hot, cold] },
    });
    expect(edit.statusCode, edit.body).toBe(200);
    expect(await tagged(hot)).toEqual(["TG One"]);
    expect(await tagged(cold)).toEqual(["TG One"]);
    // Bulk adds and removes.
    const bulk = (action: Record<string, unknown>) =>
      admin.inject({ method: "POST", url: "/api/v1/leads/bulk", payload: { ids: [one, two], action } });
    expect((await bulk({ type: "tags", add: [hot] })).statusCode).toBe(200);
    expect(await tagged(hot)).toEqual(["TG One", "TG Two"]);
    expect((await bulk({ type: "tags", remove: [cold] })).statusCode).toBe(200);
    expect(await tagged(cold)).toEqual([]);
    // The lead's own view still lists its tags.
    const view = (await admin.inject({ method: "GET", url: `/api/v1/leads/${two}` })).json().lead;
    expect(view.tagIds).toEqual([hot]);
    // A tag deleted leaves no lead holding it; a deleted lead leaves the filter.
    expect((await admin.inject({ method: "DELETE", url: `/api/v1/tags/${hot}` })).statusCode).toBeLessThan(
      300,
    );
    expect(await tagged(hot)).toEqual([]);
    const left = await h.queryAll<{ n: number }>(
      "SELECT count(*)::int AS n FROM lead_tags WHERE tag_id = $1",
      [hot],
    );
    expect(left[0]!.n).toBe(0);
  });
});

describe("7A: tags for a page or a file of leads", () => {
  it("reads them in one statement however many leads (an export holds up to 25,000; one parameter each was slow)", async () => {
    const lead = await h.seedLead({ ownerId: adminId, name: "TF One" });
    const tag = newId();
    await h.queryAll("INSERT INTO tags (id, label) VALUES ($1, $2)", [tag, `TF ${tag.slice(-6)}`]);
    await h.queryAll("INSERT INTO lead_tags (lead_id, tag_id) VALUES ($1, $2)", [lead, tag]);
    const c = await h.ownerPool.connect();
    try {
      await c.query("BEGIN");
      await c.query(
        "SELECT set_config('lume.user_id', $1, true), set_config('lume.lead_scope', 'all', true)",
        [adminId],
      );
      const req = { db: drizzle(c, { schema: dbSchema }) } as unknown as FastifyRequest;
      // 70,000 ids: past Postgres' 65,535 parameters, so only a single array parameter can carry them.
      const ids = [lead, ...Array.from({ length: 69_999 }, () => newId())];
      const got = await tagsFor(req, ids);
      expect(got.get(lead)).toEqual([tag]);
      expect(got.size).toBe(1);
    } finally {
      await c.query("ROLLBACK");
      c.release();
    }
  });
});

describe("7A: search through its indexes", () => {
  const find = async (c: AuthedClient, term: string) => {
    const r = await c.inject({ method: "GET", url: `/api/v1/leads?limit=100&q=${encodeURIComponent(term)}` });
    expect(r.statusCode, r.body).toBe(200);
    return {
      names: (r.json().items as { name: string }[]).map((l) => l.name).sort(),
      capped: r.json().searchCapped,
    };
  };

  it("finds by name, email and phone digits; a literal %, _ or \\ is just a character (Review Focus 3)", async () => {
    const odd = [
      ["SR 100% Sure", "+971501110001", "sure@srch.test"],
      ["SR under_score", "+971501110002", "under@srch.test"],
      ["SR back\\slash", "+971501110003", "back@srch.test"],
      ["SR O'Brien", "+971501110004", "obrien@srch.test"],
      ["SR Zoë Ángel", "+971501110005", "zoe@srch.test"],
      ["SR Rose 🌹", "+971501110006", "rose@srch.test"],
      [`SR ${"Long".repeat(48)}`, "+971501110007", "long@srch.test"],
    ] as const;
    for (const [name, phone, email] of odd) await h.seedLead({ ownerId: adminId, name, phone, email });
    expect((await find(admin, "100%")).names).toEqual(["SR 100% Sure"]);
    expect((await find(admin, "1_0")).names).toEqual([]); // "_" is not a wildcard (it would match "100")
    expect((await find(admin, "under_")).names).toEqual(["SR under_score"]);
    expect((await find(admin, "k\\s")).names).toEqual(["SR back\\slash"]);
    expect((await find(admin, "o'b")).names).toEqual(["SR O'Brien"]);
    expect((await find(admin, "zoë")).names).toEqual(["SR Zoë Ángel"]);
    expect((await find(admin, "se 🌹")).names).toEqual(["SR Rose 🌹"]);
    expect((await find(admin, "🌹")).names).toEqual(await names(admin, "")); // one character: no search
    expect((await find(admin, "0% S")).names).toEqual(["SR 100% Sure"]);
    expect((await find(admin, "LongLongLong")).names).toHaveLength(1);
    expect((await find(admin, "obrien@srch")).names).toEqual(["SR O'Brien"]);
    expect((await find(admin, "1110005")).names).toEqual(["SR Zoë Ángel"]);
    expect((await find(admin, "+971 50 111 0006")).names).toEqual(["SR Rose 🌹"]);
    expect((await find(admin, "SR 100%")).capped).toBe(false);
  });

  it("a one-letter or blank term doesn't search: the list answers as if there were no term", async () => {
    const all = await names(admin, "");
    expect((await find(admin, "S")).names).toEqual(all);
    expect((await find(admin, "   ")).names).toEqual(all);
    expect((await find(admin, "S")).capped).toBe(false);
  });

  it("a two-letter term matches names that start with it (too short to look inside names)", async () => {
    for (const n of ["Pq First", "pQ Second", "Apq Middle"]) await h.seedLead({ ownerId: adminId, name: n });
    expect((await find(admin, "pq")).names).toEqual(["Pq First", "pQ Second"]);
    expect((await find(admin, "PQ")).names).toEqual(["Pq First", "pQ Second"]);
    expect((await find(rep, "pq")).names).toEqual([]); // not theirs
  });

  it("an export of a search past the cap is refused in words, never a file of an arbitrary part (7A review)", async () => {
    for (const n of ["EXQ One", "EXQ Two", "EXQ Three"]) await h.seedLead({ ownerId: adminId, name: n });
    setSearchCapForTests(2);
    try {
      const r = await admin.inject({
        method: "POST",
        url: "/api/v1/leads/export",
        payload: { format: "csv", label: "EXQ", filters: { q: "EXQ" }, columns: ["name"] },
      });
      expect(r.statusCode, r.body).toBe(422);
      expect(r.json().error).toMatchObject({ code: "SEARCH_TOO_BROAD" });
    } finally {
      setSearchCapForTests(null);
    }
  });

  it("symbols only (nothing to look up) is no search: the list answers as if there were no term", async () => {
    const all = await names(admin, "");
    for (const t of ["!!!", "%%%", "---", "🔥🔥🔥"]) expect((await find(admin, t)).names, t).toEqual(all);
  });

  it("at the cap it answers in full; one past, it says so (Review Focus 5)", async () => {
    for (const n of ["CP Alpha", "CP Beta", "CP Gamma"]) await h.seedLead({ ownerId: adminId, name: n });
    setSearchCapForTests(3);
    try {
      expect(await find(admin, "CP ")).toEqual({ names: ["CP Alpha", "CP Beta", "CP Gamma"], capped: false });
      await h.seedLead({ ownerId: adminId, name: "CP Delta" });
      const over = await find(admin, "CP ");
      expect(over.capped).toBe(true);
      expect(over.names).toHaveLength(3);
      // The counts say the same.
      const cfg = await h.config();
      const counts = await admin.inject({
        method: "GET",
        url: `/api/v1/leads/counts?pipelineId=${cfg.pipelineId}&q=CP%20`,
      });
      expect(counts.json()).toMatchObject({ searchCapped: true });
    } finally {
      setSearchCapForTests(null);
    }
    expect((await find(admin, "CP ")).capped).toBe(false);
  });

  it("never finds a lead the person can't see; a masked role searches names only (Review Focus 3)", async () => {
    const theirs = await h.seedLead({ ownerId: adminId, name: "MV Hidden", email: "hidden@srch.test" });
    expect(theirs).toBeTruthy();
    const mine = await h.seedLead({
      ownerId: repId,
      name: "MV Mine",
      email: "mine.secret@srch.test",
      phone: "+971501110099",
    });
    expect(mine).toBeTruthy();
    expect((await find(rep, "MV ")).names).toEqual(["MV Mine"]);
    expect((await find(rep, "hidden@")).names).toEqual([]);
    // The rep sees masked contacts: their own lead isn't found by its email or phone, only its name.
    expect((await find(rep, "mine.secret")).names).toEqual([]);
    expect((await find(rep, "1110099")).names).toEqual([]);
    expect((await find(rep, "MV Mi")).names).toEqual(["MV Mine"]);
  });
});

describe("7A: the stage strip's counts come from lead_counts when they can (0048)", () => {
  it("equal a recount for every scope, with and without owner and stage filters; other filters count live", async () => {
    const cfg = await h.config();
    const stages = Object.values(cfg.stages).slice(0, 2);
    const a = await h.seedUser({ grants: [{ key: "leads.view", scope: "own" }], totp: true });
    const b = await h.seedUser({ grants: [{ key: "leads.view", scope: "own" }] });
    const lead = await h.seedUser({ grants: [{ key: "leads.view", scope: "team" }], totp: true });
    await h.seedTeam(lead.id, [a.id]);
    const ids: string[] = [];
    for (const [owner, stage, value] of [
      [a.id, stages[0], 100],
      [a.id, stages[1], null],
      [b.id, stages[0], 250.5],
      [null, stages[1], 40],
      [lead.id, stages[0], 10],
    ] as const) {
      const id = await h.seedLead({ ownerId: owner, name: "CNT lead" });
      await h.queryAll("UPDATE leads SET stage_id = $2, value = $3 WHERE id = $1", [id, stage, value]);
      ids.push(id);
    }
    // A deleted lead never counts.
    await h.queryAll("UPDATE leads SET deleted_at = now() WHERE id = $1", [
      await h.seedLead({ ownerId: a.id, name: "CNT gone" }),
    ]);
    const counts = async (c: AuthedClient, extra = "") => {
      const r = await c.inject({
        method: "GET",
        url: `/api/v1/leads/counts?pipelineId=${cfg.pipelineId}${extra}`,
      });
      expect(r.statusCode, r.body).toBe(200);
      return r.json() as { counts: Record<string, number>; values: Record<string, number>; total: number };
    };
    /** The same counts, recounted from leads for the owners a scope sees. */
    const recount = async (owners: (string | null)[] | "all", where = "") => {
      const rows = await h.queryAll<{ stage_id: string; n: number; v: string }>(
        `SELECT stage_id, count(*)::int AS n, coalesce(sum(value), 0)::text AS v FROM leads
          WHERE deleted_at IS NULL AND pipeline_id = $1 ${owners === "all" ? "" : "AND owner_id = ANY($2)"} ${where}
          GROUP BY stage_id`,
        owners === "all" ? [cfg.pipelineId] : [cfg.pipelineId, owners],
      );
      return {
        counts: Object.fromEntries(rows.map((r) => [r.stage_id, r.n])),
        values: Object.fromEntries(rows.map((r) => [r.stage_id, Number(r.v)])),
        total: rows.reduce((s, r) => s + r.n, 0),
      };
    };
    const ca = await h.signIn(a);
    const cl = await h.signIn(lead);
    expect(await counts(admin)).toMatchObject(await recount("all"));
    expect(await counts(ca)).toMatchObject(await recount([a.id]));
    expect(await counts(cl)).toMatchObject(await recount([a.id, lead.id]));
    // Owner and stage filters (still from the table), and "me" / "none".
    expect(await counts(admin, `&ownerId=${b.id}`)).toMatchObject(await recount([b.id]));
    expect(await counts(admin, "&ownerId=none")).toMatchObject(await recount("all", "AND owner_id IS NULL"));
    expect(await counts(ca, "&ownerId=me")).toMatchObject(await recount([a.id]));
    expect(await counts(ca, `&ownerId=${b.id}`)).toMatchObject({ total: 0 }); // outside their scope
    expect(await counts(admin, `&stageId=${stages[0]}`)).toMatchObject(
      await recount("all", `AND stage_id = '${stages[0]}'`),
    );
    // Any other filter counts live, and agrees.
    expect(await counts(admin, "&phoneStatus=missing")).toMatchObject(
      await recount("all", "AND phone_status = 'missing'"),
    );
  });
});
