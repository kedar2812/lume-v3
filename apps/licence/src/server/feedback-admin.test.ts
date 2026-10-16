import { testJpeg, testWebp } from "@lume/core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createAdmin } from "./auth";
import type { Ctx } from "./context";
import { pruneFeedbackImages } from "./feedback-admin";
import { adminSession, licenceDb, seedClient, testCtx, type Jar, type LicenceTestDb } from "./testing";

/** The owner's side of feedback (spec 2026-10-16 §3): the inbox, one report, its screenshots, statuses, clean-up. */
let db: LicenceTestDb;
let now = new Date("2026-10-16T10:00:00Z");
let ctx: Ctx;
let jar: Jar;
beforeAll(async () => {
  db = await licenceDb();
  ctx = testCtx(db.pool, () => now);
  await createAdmin(ctx, { email: "owner@lume.test", password: "a long and lovely passphrase" });
  jar = await adminSession(ctx);
});
afterAll(() => db.close());
beforeEach(async () => {
  now = new Date("2026-10-16T10:00:00Z");
  await db.pool.query("DELETE FROM feedback");
  await db.pool.query("UPDATE settings SET latest_version = NULL");
});

type Filed = {
  kind?: string;
  text?: string;
  at?: Date;
  status?: string;
  fixedIn?: string | null;
  images?: number;
  who?: string;
};
async function file(clientId: string, o: Filed = {}) {
  const status = o.status ?? "new";
  const closed = status === "fixed" || status === "not_a_bug";
  const { rows } = await db.pool.query<{ id: string }>(
    `INSERT INTO feedback (client_id, received_at, kind, text, reporter_name, reporter_email, reporter_role, page,
                           app_version, browser, screen, theme, image_count, status, fixed_in, closed_at)
     VALUES ($1, $2, $3, $4, $5, 'priya@harbour.example', 'Sales rep', '/pipeline', '1.4.1',
             'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
             '1536 × 864 · 1.25×', 'porcelain', $6, $7, $8, $9) RETURNING id`,
    [
      clientId,
      o.at ?? now,
      o.kind ?? "bug",
      o.text ?? "It jumped back.\nTwice.",
      o.who ?? "Priya Shah",
      o.images ?? 0,
      status,
      o.fixedIn ?? null,
      closed ? now : null,
    ],
  );
  const id = rows[0]!.id;
  for (let n = 0; n < (o.images ?? 0); n++)
    await db.pool.query(
      "INSERT INTO feedback_images (feedback_id, n, type, width, height, bytes) VALUES ($1, $2, $3, 800, 600, $4)",
      [id, n, n % 2 ? "image/jpeg" : "image/webp", Buffer.from(n % 2 ? testJpeg(800, 600) : testWebp(800, 600))],
    );
  return id;
}
const kinds = (items: { kind: string }[]) => items.map((i) => i.kind);

describe("the Feedback inbox", () => {
  it("lists by tab, newest first, with the first line, client, reporter and counts", async () => {
    const harbour = await seedClient(db.pool, { type: "subscription", name: "Harbour Clinic" });
    const north = await seedClient(db.pool, { type: "subscription", name: "Northwind Interiors" });
    const a = await file(harbour.clientId, { at: new Date("2026-10-16T09:00:00Z"), images: 2 });
    await file(north.clientId, { kind: "idea", status: "seen", at: new Date("2026-10-15T09:00:00Z") });
    await file(north.clientId, { status: "fixed", fixedIn: "1.4.2", at: new Date("2026-10-10T09:00:00Z") });
    const r = await jar.call("GET", "/api/feedback?tab=new");
    expect(r.status).toBe(200);
    expect(r.data.counts).toEqual({ new: 1, fixing: 1, fixed: 1, all: 3 });
    expect(r.data.items).toEqual([
      {
        id: a,
        receivedAt: "2026-10-16T09:00:00.000Z",
        kind: "bug",
        firstLine: "It jumped back.",
        client: { id: harbour.clientId, name: "Harbour Clinic" },
        reporter: { name: "Priya Shah", role: "Sales rep" },
        page: "/pipeline",
        status: "new",
        fixedIn: null,
        imageCount: 2,
      },
    ]);
    expect(r.data.next).toBeNull();
    expect(kinds((await jar.call("GET", "/api/feedback?tab=fixing")).data.items)).toEqual(["idea"]);
    expect((await jar.call("GET", `/api/feedback?tab=all&client=${north.clientId}`)).data.items).toHaveLength(2);
    expect((await jar.call("GET", "/api/feedback?tab=all&fixedIn=1.4.2")).data.items).toHaveLength(1);
    expect(kinds((await jar.call("GET", "/api/feedback?tab=all&kind=idea")).data.items)).toEqual(["idea"]);
    expect((await jar.call("GET", "/api/feedback/new-count")).data).toEqual({ newCount: 1 });
  });

  it("searches the words and the reporter, taking % and _ as themselves", async () => {
    const c = await seedClient(db.pool, { type: "subscription" });
    await file(c.clientId, { text: "100% of my leads vanished" });
    await file(c.clientId, { text: "Calendar is off by 30 min", who: "Omar Farooq" });
    expect((await jar.call("GET", "/api/feedback?tab=all&q=100%25")).data.items).toHaveLength(1);
    expect((await jar.call("GET", "/api/feedback?tab=all&q=_")).data.items).toHaveLength(0);
    expect((await jar.call("GET", "/api/feedback?tab=all&q=omar")).data.items).toHaveLength(1);
    expect((await jar.call("GET", "/api/feedback?tab=all&q=omar")).data.counts.all).toBe(1);
  });

  it("pages 50 at a time", async () => {
    const c = await seedClient(db.pool, { type: "subscription" });
    for (let i = 0; i < 53; i++) await file(c.clientId, { at: new Date(now.getTime() - i * 60_000) });
    const first = await jar.call("GET", "/api/feedback?tab=all");
    expect(first.data.items).toHaveLength(50);
    expect(first.data.next).toBeTruthy();
    const second = await jar.call("GET", `/api/feedback?tab=all&before=${encodeURIComponent(first.data.next)}`);
    expect(second.data.items).toHaveLength(3);
    expect(second.data.next).toBeNull();
    const ids = new Set([...first.data.items, ...second.data.items].map((i: { id: string }) => i.id));
    expect(ids.size).toBe(53);
  });

  it("refuses a tab, kind, client or page that isn't one", async () => {
    expect((await jar.call("GET", "/api/feedback?tab=open")).status).toBe(400);
    expect((await jar.call("GET", "/api/feedback?kind=rant")).status).toBe(400);
    expect((await jar.call("GET", "/api/feedback?client=nope")).status).toBe(400);
    expect((await jar.call("GET", "/api/feedback?before=yesterday")).status).toBe(400);
  });
});

describe("one report", () => {
  it("has everything, the latest release, and the client's own version", async () => {
    const c = await seedClient(db.pool, { type: "subscription", name: "Harbour Clinic" });
    await db.pool.query(
      "INSERT INTO check_ins (client_id, at, app_version, active_users, lead_count, state) VALUES ($1, $2, '1.4.1', 9, 3402, 'active')",
      [c.clientId, now],
    );
    await db.pool.query("UPDATE settings SET latest_version = '1.4.2'");
    const id = await file(c.clientId, { images: 2 });
    const r = await jar.call("GET", `/api/feedback/${id}`);
    expect(r.status).toBe(200);
    expect(r.data).toMatchObject({
      id,
      status: "new",
      text: "It jumped back.\nTwice.",
      reporter: { name: "Priya Shah", role: "Sales rep", email: "priya@harbour.example" },
      appVersion: "1.4.1",
      screen: "1536 × 864 · 1.25×",
      theme: "porcelain",
      note: "",
      latestRelease: "1.4.2",
      clientVersion: "1.4.1",
      images: [
        { n: 0, type: "image/webp", width: 800, height: 600 },
        { n: 1, type: "image/jpeg", width: 800, height: 600 },
      ],
      imagesRemovedAt: null,
      closedAt: null,
    });
    expect((await jar.call("GET", "/api/feedback/00000000-0000-0000-0000-000000000000")).status).toBe(404);
    expect((await jar.call("GET", "/api/feedback/not-an-id")).status).toBe(404);
  });

  it("sends a screenshot as itself: its type, nosniff, private, and as a download when asked", async () => {
    const c = await seedClient(db.pool, { type: "subscription" });
    const id = await file(c.clientId, { images: 2 });
    const r = await jar.raw("GET", `/api/feedback/${id}/images/1`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("image/jpeg");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(r.headers.get("cache-control")).toBe("private, max-age=3600");
    expect(Buffer.from(await r.arrayBuffer())).toEqual(Buffer.from(testJpeg(800, 600)));
    const d = await jar.raw("GET", `/api/feedback/${id}/images/0?download=1`);
    expect(d.headers.get("content-disposition")).toMatch(/^attachment; filename="feedback-[0-9a-f]{8}-0\.webp"$/);
    expect((await jar.raw("GET", `/api/feedback/${id}/images/4`)).status).toBe(404);
    expect((await jar.raw("GET", `/api/feedback/${id}/images/9`)).status).toBe(404);
  });

  it("moves through its statuses, writing each change to the client's history, and keeps the note", async () => {
    const c = await seedClient(db.pool, { type: "subscription" });
    const id = await file(c.clientId);
    const patch = (b: unknown) => jar.call("PATCH", `/api/feedback/${id}`, b);
    expect((await patch({ status: "seen" })).data.status).toBe("seen");
    expect((await patch({ status: "fixed" })).status).toBe(400);
    const fixed = await patch({ status: "fixed", fixedIn: "1.4.3" });
    expect(fixed.data).toMatchObject({ status: "fixed", fixedIn: "1.4.3", closedAt: now.toISOString() });
    const reopened = await patch({ status: "seen" });
    expect(reopened.data).toMatchObject({ status: "seen", fixedIn: null, closedAt: null });
    expect((await patch({ note: "Pipeline drag race — see #212" })).data.note).toBe("Pipeline drag race — see #212");
    expect((await patch({ status: "new" })).status).toBe(400);
    expect((await patch({ status: "fixed", fixedIn: "v2" })).status).toBe(400);
    expect((await patch({ fixedIn: "1.4.4" })).status).toBe(400);
    expect((await patch({ note: "x".repeat(2001) })).status).toBe(400);
    expect((await patch({ extra: true })).status).toBe(400);
    const ev = await db.pool.query(
      "SELECT detail FROM events WHERE client_id = $1 AND kind = 'feedback_status' ORDER BY id",
      [c.clientId],
    );
    expect(ev.rows.map((r) => r.detail)).toEqual([
      { id, from: "new", to: "seen" },
      { id, from: "seen", to: "fixed", fixedIn: "1.4.3" },
      { id, from: "fixed", to: "seen" },
    ]);
  });
});

describe("elsewhere", () => {
  it("a client's page has its latest three reports and its counts", async () => {
    const c = await seedClient(db.pool, { type: "subscription", name: "Harbour Clinic" });
    for (let i = 0; i < 4; i++)
      await file(c.clientId, { at: new Date(now.getTime() - i * 3_600_000), status: i ? "seen" : "new" });
    const r = await jar.call("GET", `/api/clients/${c.clientId}`);
    expect(r.status).toBe(200);
    expect(r.data.feedback.total).toBe(4);
    expect(r.data.feedback.new).toBe(1);
    expect(r.data.feedback.latest).toHaveLength(3);
    expect(r.data.feedback.latest[0]).toMatchObject({
      firstLine: "It jumped back.",
      status: "new",
      reporterName: "Priya Shah",
    });
  });

  it("Releases counts the reports each version fixed", async () => {
    const c = await seedClient(db.pool, { type: "subscription" });
    await file(c.clientId, { status: "fixed", fixedIn: "1.4.2" });
    await file(c.clientId, { status: "fixed", fixedIn: "1.4.2" });
    await file(c.clientId, { status: "fixed", fixedIn: "1.4.1" });
    await file(c.clientId, { status: "not_a_bug" });
    expect((await jar.call("GET", "/api/releases")).data.fixed).toEqual({ "1.4.2": 2, "1.4.1": 1 });
  });

  it("removes screenshots 90 days after a report is closed, and keeps the words", async () => {
    const c = await seedClient(db.pool, { type: "subscription" });
    const old = await file(c.clientId, { status: "fixed", fixedIn: "1.4.0", images: 2 });
    const open = await file(c.clientId, { images: 1 });
    expect(await pruneFeedbackImages(db.pool, new Date(now.getTime() + 89 * 86_400_000))).toBe(0);
    expect(await pruneFeedbackImages(db.pool, new Date(now.getTime() + 90 * 86_400_000))).toBe(1);
    const left = await db.pool.query("SELECT DISTINCT feedback_id FROM feedback_images");
    expect(left.rows.map((r) => r.feedback_id)).toEqual([open]);
    const f = (await db.pool.query("SELECT text, image_count, images_removed_at FROM feedback WHERE id = $1", [old]))
      .rows[0];
    expect(f.text).toBe("It jumped back.\nTwice.");
    expect(f.image_count).toBe(2);
    expect(f.images_removed_at).not.toBeNull();
    expect((await jar.call("GET", `/api/feedback/${old}`)).data.imagesRemovedAt).not.toBeNull();
  });
});
