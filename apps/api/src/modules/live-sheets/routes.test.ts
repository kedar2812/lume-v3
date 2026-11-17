import http from "node:http";
import type { AddressInfo } from "node:net";
import { ALL_GRANTS, newId, totpCode, type Grant, type LiveSheetRule, type PlanTier } from "@lume/core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createRelay } from "../../../../connect/src/relay";
import { createHarness, type AuthedClient, type Harness, type SeededUser } from "../../../test/harness";
import { ALL_MODULES, testLicence } from "../../../test/licence-plan";
import { grantContext } from "./connect";

/** Live sheets (spec 2026-11-14): the routes the page and the form use. */
const RELAY_TOKEN = "t".repeat(40);
let h: Harness;
let relay: http.Server;
let maya: SeededUser;
let admin: AuthedClient;
let stages: Record<string, string>;

async function withRelay(harness: Harness) {
  const server = http.createServer(
    createRelay({
      publicUrl: "http://relay.test",
      clientId: "cid",
      clientSecret: "cs",
      pickerKey: "pk",
      appId: "1",
      secret: "s".repeat(40),
      instances: [{ url: "https://lume.test", token: RELAY_TOKEN }],
      googleTokenUrl: `${harness.fake!.url}/token`,
      googleApiUrl: harness.fake!.url,
    }),
  );
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  harness.setRelayUrl(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  return server;
}
async function grantOf(harness: Harness, user: SeededUser, token = "rt-ok-routes") {
  const id = newId();
  const c = await harness.ownerPool.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT set_config('lume.user_id', $1, true)", [user.id]);
    await c.query(
      "INSERT INTO live_sheet_grants (id, user_id, google_email, grant_enc) VALUES ($1, $2, $3, $4)",
      [id, user.id, `${id}@business.test`, harness.keyring.encrypt(token, grantContext(id))],
    );
    await c.query("COMMIT");
  } finally {
    c.release();
  }
  return id;
}
const sheetsOn = async (c: AuthedClient) =>
  expect(
    (await c.inject({ method: "PUT", url: "/api/v1/integrations/google-sheets", payload: { enabled: true } }))
      .statusCode,
  ).toBe(200);

beforeAll(async () => {
  h = await createHarness({ preset: "general", google: true, oauth: { relayToken: RELAY_TOKEN } });
  relay = await withRelay(h);
  maya = await h.seedUser({ grants: ALL_GRANTS, totp: true, name: "Maya Kapoor" });
  admin = await h.signIn(maya);
  await sheetsOn(admin);
  stages = (await h.config()).stages;
});
afterAll(async () => {
  relay.close();
  await h.close();
});
beforeEach(async () => {
  await h.ownerPool.query(
    "DELETE FROM live_sheet_runs; DELETE FROM live_sheet_rows; DELETE FROM live_sheets",
  );
  h.liveSheetQueue.length = 0;
  h.fake!.made.reset();
});

const rule = (over: Partial<LiveSheetRule> = {}): LiveSheetRule => ({
  stages: { mode: "reached", stageIds: [stages.Qualified!] },
  includeMissing: true,
  includeDnc: false,
  backfill: true,
  ...over,
});
const call = (c: AuthedClient, method: "GET" | "POST" | "PATCH" | "DELETE", url: string, payload?: unknown) =>
  c.inject({ method, url, ...(payload !== undefined ? { payload: payload as object } : {}) });
const make = async (c: AuthedClient, grantId: string, over: Record<string, unknown> = {}) =>
  call(c, "POST", "/api/v1/live-sheets", {
    name: "Qualified leads",
    preset: "meta",
    rule: rule(),
    columns: [],
    edits: "keep",
    grantId,
    ...over,
  });
const audited = (action: string) =>
  h
    .queryAll<{ n: number }>("SELECT count(*)::int AS n FROM audit_log WHERE action = $1", [action])
    .then((r) => r[0]!.n);

describe("making a live sheet", () => {
  it("makes it, queues its first run, says so in the log, and lists it with its rule in words", async () => {
    const before = await audited("live_sheet.created");
    const r = await make(admin, await grantOf(h, maya));
    expect(r.statusCode, r.body).toBe(201);
    const s = r.json().sheet;
    expect(s).toMatchObject({ name: "Qualified leads", preset: "meta", status: "making", edits: "keep" });
    expect(s.ruleWords).toBe("Leads that reached Qualified");
    expect(h.liveSheetQueue.map((j) => j.sheetId)).toEqual([s.id]);
    expect(await audited("live_sheet.created")).toBe(before + 1);
    const list = (await call(admin, "GET", "/api/v1/live-sheets")).json().sheets;
    expect(list.map((x: { id: string }) => x.id)).toContain(s.id);
    // The run makes it in Google; the list then carries its link.
    await h.seedLead({ ownerId: maya.id, stage: "Qualified", email: "a@x.test" });
    await h.runLiveSheets();
    const after = (await call(admin, "GET", `/api/v1/live-sheets/${s.id}`)).json().sheet;
    expect(after).toMatchObject({ status: "live", leadCount: 1, madeBy: { name: "Maya Kapoor" } });
    expect(after.url).toMatch(/^https:\/\/docs\.google\.com\//);
  });

  it("is refused, in words, without Export leads, with someone else's Google account, or a name LUME uses", async () => {
    const noExport = await h.seedUser({
      grants: ALL_GRANTS.filter((g) => g.key !== "leads.export"),
      totp: true,
    });
    const r1 = await make(await h.signIn(noExport), await grantOf(h, noExport));
    expect(r1.statusCode).toBe(403);
    expect(r1.json().error.code).toBe("NO_EXPORT_ACCESS");
    const other = await h.seedUser({ grants: ALL_GRANTS, totp: true });
    const r2 = await make(admin, await grantOf(h, other));
    expect(r2.json().error.code).toBe("GRANT_NOT_YOURS");
    const r3 = await make(admin, await grantOf(h, maya), { name: "Made with LUME" });
    expect(r3.json().error.code).toBe("NAME_RESERVED");
    const r4 = await make(admin, await grantOf(h, maya), { name: "   " });
    expect(r4.statusCode).toBe(400);
  });

  it("a masked role can't take phones and emails out; a column hidden from you can't go in", async () => {
    const masked: Grant[] = ALL_GRANTS.filter((g) => g.key !== "leads.contact.full");
    const m = await h.seedUser({ grants: masked, totp: true });
    const mc = await h.signIn(m);
    const r = await make(mc, await grantOf(h, m));
    expect(r.json().error.code).toBe("CONTACTS_MASKED");
    // My own columns without contacts is fine for them.
    expect(
      (await make(mc, await grantOf(h, m), { preset: "own", columns: ["name", "stage"] })).statusCode,
    ).toBe(201);
    const r2 = await make(admin, await grantOf(h, maya), { preset: "own", columns: ["name", "custom:nope"] });
    expect(r2.json().error.code).toBe("COLUMN_HIDDEN");
  });

  it("twenty is the most a business keeps", async () => {
    const g = await grantOf(h, maya);
    for (let i = 0; i < 20; i++) expect((await make(admin, g, { name: `S${i}` })).statusCode).toBe(201);
    const r = await make(admin, g, { name: "One more" });
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe("LIVE_SHEETS_FULL");
  });

  it("the count the form shows: the leads the rule holds, and those with no phone or email", async () => {
    await h.queryAll("UPDATE leads SET deleted_at = now()");
    await h.seedLead({ ownerId: maya.id, stage: "Qualified", email: "a@x.test" });
    await h.seedLead({ ownerId: maya.id, stage: "Qualified" });
    await h.seedLead({ ownerId: maya.id, stage: "New", email: "b@x.test" });
    const r = await call(admin, "POST", "/api/v1/live-sheets/count", { preset: "meta", rule: rule() });
    expect(r.json()).toEqual({ matching: 2, missingContact: 1 });
    const strict = await call(admin, "POST", "/api/v1/live-sheets/count", {
      preset: "meta",
      rule: rule({ includeMissing: false }),
    });
    expect(strict.json()).toEqual({ matching: 1, missingContact: 1 });
  });
});

describe("changing a live sheet", () => {
  const fresh = async () => {
    const s = (await make(admin, await grantOf(h, maya))).json().sheet;
    await h.runLiveSheets();
    return s.id as string;
  };

  it("Edit renames it in Google too, at its run", async () => {
    const id = await fresh();
    const r = await call(admin, "PATCH", `/api/v1/live-sheets/${id}`, {
      name: "Won clients",
      edits: "replace",
    });
    expect(r.statusCode, r.body).toBe(200);
    expect(h.liveSheetQueue).toHaveLength(1);
    await h.runLiveSheets();
    const s = (await call(admin, "GET", `/api/v1/live-sheets/${id}`)).json().sheet;
    expect(s).toMatchObject({ name: "Won clients", edits: "replace" });
    const sid = new URL(s.url).pathname.split("/")[3]!;
    expect(h.fake!.made.get(sid)!.title).toBe("Won clients");
    expect(await audited("live_sheet.edited")).toBeGreaterThan(0);
  });

  it("Pause, Update now while paused keeps it paused, Resume runs it again", async () => {
    const id = await fresh();
    await call(admin, "POST", `/api/v1/live-sheets/${id}/pause`);
    let s = (await call(admin, "GET", `/api/v1/live-sheets/${id}`)).json().sheet;
    expect(s).toMatchObject({ status: "paused", pauseReason: "paused_by_person" });
    await call(admin, "POST", `/api/v1/live-sheets/${id}/resume`);
    expect(h.liveSheetQueue.map((j) => j.sheetId)).toContain(id);
    await h.runLiveSheets();
    s = (await call(admin, "GET", `/api/v1/live-sheets/${id}`)).json().sheet;
    expect(s.status).toBe("live");
  });

  it("Update now runs it at once; twice at once is one run", async () => {
    const id = await fresh();
    await Promise.all([1, 2].map(() => call(admin, "POST", `/api/v1/live-sheets/${id}/run`)));
    expect(h.liveSheetQueue).toHaveLength(1);
  });

  it("Take it over: an admin becomes who it runs as; someone who can't manage people can't", async () => {
    const id = await fresh();
    const lead = await h.seedUser({ grants: ALL_GRANTS, totp: true, name: "Leila Haddad" });
    const r = await call(await h.signIn(lead), "POST", `/api/v1/live-sheets/${id}/take-over`);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().sheet.runsAs.name).toBe("Leila Haddad");
    const rep = await h.seedUser({
      grants: ALL_GRANTS.filter((g) => g.key !== "users.manage" && g.key !== "settings.manage"),
      totp: true,
    });
    const no = await call(await h.signIn(rep), "POST", `/api/v1/live-sheets/${id}/take-over`);
    expect(no.statusCode).toBe(403);
  });

  it("someone else who makes live sheets can't change, pause, resume, remake or delete it; Update now still works (bug hunt 2026-11-17)", async () => {
    const id = await fresh();
    const other = await h.seedUser({
      grants: ALL_GRANTS.filter((g) => g.key !== "users.manage" && g.key !== "settings.manage"),
      totp: true,
      name: "Omar Shaikh",
    });
    const c = await h.signIn(other);
    for (const [method, url, payload] of [
      ["PATCH", `/api/v1/live-sheets/${id}`, { rule: rule({ includeDnc: true }) }],
      ["POST", `/api/v1/live-sheets/${id}/pause`, undefined],
      ["POST", `/api/v1/live-sheets/${id}/resume`, undefined],
      ["POST", `/api/v1/live-sheets/${id}/remake`, undefined],
      ["DELETE", `/api/v1/live-sheets/${id}`, undefined],
    ] as const) {
      const r = await call(c, method, url, payload);
      expect(r.statusCode, `${method} ${url}: ${r.body}`).toBe(403);
    }
    const s = (await call(admin, "GET", `/api/v1/live-sheets/${id}`)).json().sheet;
    expect(s.status).toBe("live");
    expect(s.rule.includeDnc).toBe(false);
    expect((await call(c, "POST", `/api/v1/live-sheets/${id}/run`)).statusCode).toBe(200);
  });

  it("Delete stops it and leaves the file, or moves the file to Google's bin when asked", async () => {
    const keep = await fresh();
    const keepUrl = (await call(admin, "GET", `/api/v1/live-sheets/${keep}`)).json().sheet.url as string;
    expect((await call(admin, "DELETE", `/api/v1/live-sheets/${keep}`)).statusCode).toBe(200);
    expect((await call(admin, "GET", `/api/v1/live-sheets/${keep}`)).statusCode).toBe(404);
    expect(h.fake!.made.get(new URL(keepUrl).pathname.split("/")[3]!)!.trashed).toBe(false);
    const bin = await fresh();
    const binUrl = (await call(admin, "GET", `/api/v1/live-sheets/${bin}`)).json().sheet.url as string;
    expect((await call(admin, "DELETE", `/api/v1/live-sheets/${bin}?trash=1`)).statusCode).toBe(200);
    expect(h.fake!.made.get(new URL(binUrl).pathname.split("/")[3]!)!.trashed).toBe(true);
    expect(await audited("live_sheet.deleted")).toBeGreaterThanOrEqual(2);
  });

  it("deleting the account of whoever's Google it writes with: LUME forgets that account, the sheet pauses", async () => {
    const noor = await h.seedUser({ grants: ALL_GRANTS, totp: true, name: "Noor Ahmed" });
    const noorC = await h.signIn(noor);
    const s = (await make(noorC, await grantOf(h, noor))).json().sheet;
    const r = await call(admin, "POST", `/api/v1/users/${noor.id}/delete`, {
      leads: { to: "none" },
      password: maya.password,
      code: totpCode(maya.totpSecret!, h.clock.now.getTime()),
    });
    expect(r.statusCode, r.body).toBeLessThan(300);
    const after = (await call(admin, "GET", `/api/v1/live-sheets/${s.id}`)).json().sheet;
    expect(after).toMatchObject({ status: "paused", pauseReason: "google_disconnected" });
    const grants = await h.queryAll<{ n: number }>(
      "SELECT count(*)::int AS n FROM live_sheet_grants WHERE user_id = $1",
      [noor.id],
    );
    expect(grants[0]!.n).toBe(0);
  });

  it("the file deleted in Google: Make it again makes a new one, filled from the start", async () => {
    const id = await fresh();
    const old = (await call(admin, "GET", `/api/v1/live-sheets/${id}`)).json().sheet.url as string;
    h.fake!.made.removeFile(new URL(old).pathname.split("/")[3]!);
    await call(admin, "POST", `/api/v1/live-sheets/${id}/run`);
    await h.runLiveSheets();
    expect((await call(admin, "GET", `/api/v1/live-sheets/${id}`)).json().sheet.pauseReason).toBe(
      "sheet_gone",
    );
    const r = await call(admin, "POST", `/api/v1/live-sheets/${id}/remake`);
    expect(r.statusCode, r.body).toBe(200);
    await h.runLiveSheets();
    const s = (await call(admin, "GET", `/api/v1/live-sheets/${id}`)).json().sheet;
    expect(s.status).toBe("live");
    expect(s.url).not.toBe(old);
  });

  it("only people who make live sheets see them", async () => {
    const viewer = await h.signIn(
      await h.seedUser({ grants: [{ key: "leads.view", scope: "all" }], totp: true }),
    );
    expect((await call(viewer, "GET", "/api/v1/live-sheets")).statusCode).toBe(403);
  });
});

describe("live sheets on a plan", () => {
  let p: Harness;
  let server: http.Server;
  const licence = testLicence({ instanceId: "LUME-TEST-LIVE-ROUTES", now: () => p.clock.now });
  it("on Base the form is refused, saying the plan", async () => {
    p = await createHarness({
      preset: "general",
      google: true,
      oauth: { relayToken: RELAY_TOKEN },
      licence: licence.options,
    });
    server = await withRelay(p);
    const u = await p.seedUser({ grants: ALL_GRANTS, totp: true });
    const c = await p.signIn(u);
    await sheetsOn(c);
    const tier = async (t: PlanTier | null) => {
      licence.setPlan({
        places: null,
        modules: ALL_MODULES,
        aiReadsHourly: null,
        aiLeadsMonthly: null,
        tier: t,
      });
      expect((await c.inject({ method: "POST", url: "/api/v1/licence/check" })).statusCode).toBeLessThan(300);
    };
    await tier("base");
    stages = (await p.config()).stages;
    const r = await make(c, await grantOf(p, u));
    expect(r.statusCode).toBe(403);
    expect(r.json().error.code).toBe("LIVE_SHEETS_TIER");
    expect(r.json().error.message).toBe(
      "Live sheets come with Pro, Max and Enterprise. Your LUME is on Base.",
    );
    await tier("pro");
    expect((await make(c, await grantOf(p, u))).statusCode).toBe(201);
    server.close();
    await p.close();
  });
});
