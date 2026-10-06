import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Limiter } from "@/lib/limit";
import { handleApi } from "./api";
import { createAdmin } from "./auth";
import type { Ctx } from "./context";
import { handleEnquiry } from "./enquiries";
import { adminSession, type Jar, licenceDb, testCtx, type LicenceTestDb } from "./testing";

/** Enquiries from lumecrm.in (website spec §7). */
let t: LicenceTestDb;
let now = new Date("2026-10-07T05:00:00Z");
let ctx: Ctx;
const TOKEN = "test-enquiry-token-0123456789abcdef";
const BODY = {
  name: "Ananya Rao",
  business: "Petal & Plate Studio",
  whatsapp: "+919812345678",
  email: "ananya@example.com",
  teamSize: "2-5",
  how: "Instagram DMs and a Google Form",
};
const post = (body: unknown, o: { token?: string | null; ip?: string; c?: Ctx } = {}) =>
  handleEnquiry(
    new Request("https://licence.test/v1/enquiries", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-real-ip": o.ip ?? "198.51.100.7",
        ...(o.token === null ? {} : { authorization: `Bearer ${o.token ?? TOKEN}` }),
      },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    o.c ?? ctx,
  );

let admin: Jar;
beforeAll(async () => {
  t = await licenceDb();
  ctx = testCtx(t.pool, () => now);
  await createAdmin(ctx, { email: "owner@lume.test", password: "a long and lovely passphrase" });
  admin = await adminSession(ctx);
});
afterAll(async () => t.close());

describe("enquiries from the website", () => {
  it("files one and answers 201 with its id", async () => {
    const r = await post(BODY);
    expect(r.status).toBe(201);
    const { id } = (await r.json()) as { id: string };
    const row = (
      await t.pool.query(
        "SELECT name, business, whatsapp, team_size, status, source FROM enquiries WHERE id = $1",
        [id],
      )
    ).rows[0];
    expect(row).toEqual({
      name: "Ananya Rao",
      business: "Petal & Plate Studio",
      whatsapp: "+919812345678",
      team_size: "2-5",
      status: "new",
      source: "website",
    });
  });

  it("refuses without the token, or with a wrong one of the same length", async () => {
    expect((await post(BODY, { token: null })).status).toBe(401);
    expect((await post(BODY, { token: TOKEN.replace(/.$/, "x") })).status).toBe(401);
  });

  it("is closed until the token is set up", async () => {
    const off = testCtx(t.pool, () => now, { enquiryToken: null });
    expect((await post(BODY, { c: off })).status).toBe(503);
  });

  it("folds the same WhatsApp number within ten minutes into one", async () => {
    const a = (await (await post({ ...BODY, whatsapp: "+919800000001" })).json()) as { id: string };
    now = new Date(now.getTime() + 5 * 60_000);
    const b = (await (await post({ ...BODY, whatsapp: "+919800000001", how: "Walk-ins too" })).json()) as {
      id: string;
    };
    expect(b.id).toBe(a.id);
    const row = (await t.pool.query("SELECT how FROM enquiries WHERE id = $1", [a.id])).rows[0];
    expect(row.how).toBe("Walk-ins too");
    now = new Date(now.getTime() + 11 * 60_000);
    const c = (await (await post({ ...BODY, whatsapp: "+919800000001" })).json()) as { id: string };
    expect(c.id).not.toBe(a.id);
  });

  it("keeps names as typed, refuses what's too long, and what isn't an enquiry", async () => {
    expect((await post({ ...BODY, whatsapp: "+919800000002", name: "Zoë D’Souza ✨" })).status).toBe(201);
    expect((await post({ ...BODY, whatsapp: "+919800000003", name: "x".repeat(121) })).status).toBe(400);
    expect((await post({ ...BODY, whatsapp: "98123" })).status).toBe(400);
    expect((await post({ ...BODY, extra: 1 })).status).toBe(400);
    expect((await post("{not json")).status).toBe(400);
    expect((await post({ ...BODY, how: "y".repeat(20_000) })).status).toBe(413);
  });

  it("limits one address, and everyone together", async () => {
    const tight = testCtx(t.pool, () => now, {
      limits: {
        ...ctx.limits,
        enquiryIp: new Limiter(3, 3_600_000),
        enquiryAll: new Limiter(5, 3_600_000),
      },
    });
    const at = (n: number, ip: string) => post({ ...BODY, whatsapp: `+9199000001${n}` }, { ip, c: tight });
    for (let i = 0; i < 3; i++) expect((await at(i, "203.0.113.9")).status).toBe(201);
    expect((await at(3, "203.0.113.9")).status).toBe(429);
    expect((await at(4, "203.0.113.10")).status).toBe(201);
    expect((await at(5, "203.0.113.11")).status).toBe(201);
    expect((await at(6, "203.0.113.12")).status).toBe(429);
  });
});

type Listed = { id: string; createdAt: string; status: string; updatedAt: string; name: string };

describe("the panel's enquiries (website spec §7)", () => {
  it("lists newest first with the count of new ones, and filters by status", async () => {
    const r = await admin.call("GET", "/api/enquiries?status=all");
    expect(r.status).toBe(200);
    const d = r.data as { enquiries: Listed[]; newCount: number };
    expect(d.enquiries.length).toBeGreaterThan(3);
    const times = d.enquiries.map((e) => e.createdAt);
    expect(times).toEqual([...times].sort().reverse());
    expect(d.newCount).toBe(d.enquiries.filter((e) => e.status === "new").length);
    const onlyNew = (await admin.call("GET", "/api/enquiries?status=new")).data as { enquiries: Listed[] };
    expect(onlyNew.enquiries.every((e) => e.status === "new")).toBe(true);
    expect((await admin.call("GET", "/api/enquiries?status=maybe")).status).toBe(400);
  });

  it("sets a status and notes; a save over someone else's is refused in words", async () => {
    const list = (await admin.call("GET", "/api/enquiries?status=all")).data as { enquiries: Listed[] };
    const e = list.enquiries[0]!;
    now = new Date(now.getTime() + 60_000);
    const ok = await admin.call("PATCH", `/api/enquiries/${e.id}`, {
      status: "contacted",
      notes: "Called, demo Thursday",
      expectedUpdatedAt: e.updatedAt,
    });
    expect(ok.status).toBe(200);
    expect((ok.data as { enquiry: { status: string; notes: string } }).enquiry).toMatchObject({
      status: "contacted",
      notes: "Called, demo Thursday",
    });
    const stale = await admin.call("PATCH", `/api/enquiries/${e.id}`, {
      status: "won",
      expectedUpdatedAt: e.updatedAt,
    });
    expect(stale.status).toBe(409);
    expect((stale.data as { error: { code: string; message: string } }).error).toEqual({
      code: "CHANGED",
      message: "Changed elsewhere — reload to see it.",
    });
    const one = (await admin.call("GET", `/api/enquiries/${e.id}`)).data as { enquiry: { status: string } };
    expect(one.enquiry.status).toBe("contacted");
  });

  it("is the admin's alone", async () => {
    const r = await handleApi(new Request("https://licence.test/api/enquiries"), ctx);
    expect(r.status).toBe(401);
  });
});
