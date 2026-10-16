import { randomUUID } from "node:crypto";
import { feedbackBody, testJpeg, testWebp } from "@lume/core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { hashKey } from "@/lib/keys";
import { ROTATE_OVERLAP_MS } from "./check";
import type { Ctx } from "./context";
import { handleFeedback } from "./feedback";
import { bindInstall, licenceDb, seedClient, testCtx, type LicenceTestDb } from "./testing";

/** Feedback from a client's LUME (spec 2026-10-16 §2.1): only from the install its key is bound to, checked again. */
let db: LicenceTestDb;
let now = new Date("2026-10-16T10:00:00Z");
let ctx: Ctx;
beforeAll(async () => {
  db = await licenceDb();
});
afterAll(() => db.close());
beforeEach(() => {
  now = new Date("2026-10-16T10:00:00Z");
  ctx = testCtx(db.pool, () => now);
});

const b64 = (u: Uint8Array) => Buffer.from(u).toString("base64");
type Creds = { instanceId: string; licenseKey: string; installId: string };
type Seed = Awaited<ReturnType<typeof seedClient>> & { installId: string };
async function bound(o: Partial<Parameters<typeof seedClient>[1]> = {}): Promise<Seed> {
  const s = await seedClient(db.pool, { type: "subscription", paidUntil: "2026-12-31", ...o });
  return { ...s, installId: await bindInstall(db.pool, s.clientId) };
}
const report = (s: Creds, over: Record<string, unknown> = {}) => ({
  ...feedbackBody({
    instanceId: s.instanceId,
    licenseKey: s.licenseKey,
    installId: s.installId,
    appVersion: "1.5.0",
    browser: "Mozilla/5.0 (Windows NT 10.0) Chrome/141.0.0.0",
    reporter: { name: "Priya Shah", email: "priya@harbour.example", role: "Sales rep" },
    report: {
      kind: "bug",
      text: "I dragged a lead to Meeting set and it jumped back.",
      page: "/pipeline",
      theme: "porcelain",
      screen: "1536 × 864 · 1.25×",
      images: [
        { type: "image/webp", data: b64(testWebp(1920, 1080)) },
        { type: "image/jpeg", data: b64(testJpeg(800, 600)) },
      ],
    },
  }),
  ...over,
});
const post = (body: unknown, ip = "198.51.100.20") =>
  handleFeedback(
    new Request("https://licence.test/v1/feedback", {
      method: "POST",
      headers: { "content-type": "application/json", "x-real-ip": ip },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    ctx,
  );
const code = async (r: Response) => ((await r.json()) as { error: { code: string } }).error.code;
const retire = (s: Seed, reason: "rotated" | "decommissioned") =>
  db.pool.query(
    `INSERT INTO retired_keys (key_hash, client_id, key_last4, reason, retired_at, install_id)
     VALUES ($1, $2, 'XXXX', $3, $4, $5)`,
    [hashKey(s.licenseKey), s.clientId, reason, now, s.installId],
  );

describe("POST /v1/feedback", () => {
  it("keeps a report from the install its key is bound to, with its screenshots and a line in the history", async () => {
    const s = await bound({ name: "Harbour Clinic" });
    const r = await post(report(s));
    expect(r.status).toBe(201);
    const { id } = (await r.json()) as { id: string };
    const f = (await db.pool.query("SELECT * FROM feedback WHERE id = $1", [id])).rows[0];
    expect(f).toMatchObject({
      client_id: s.clientId,
      kind: "bug",
      text: "I dragged a lead to Meeting set and it jumped back.",
      reporter_name: "Priya Shah",
      reporter_email: "priya@harbour.example",
      reporter_role: "Sales rep",
      page: "/pipeline",
      app_version: "1.5.0",
      theme: "porcelain",
      screen: "1536 × 864 · 1.25×",
      status: "new",
      image_count: 2,
    });
    const imgs = await db.pool.query(
      "SELECT n, type, width, height FROM feedback_images WHERE feedback_id = $1 ORDER BY n",
      [id],
    );
    expect(imgs.rows).toEqual([
      { n: 0, type: "image/webp", width: 1920, height: 1080 },
      { n: 1, type: "image/jpeg", width: 800, height: 600 },
    ]);
    const ev = await db.pool.query(
      "SELECT kind, detail FROM events WHERE client_id = $1 AND kind = 'feedback_received'",
      [s.clientId],
    );
    expect(ev.rows).toEqual([{ kind: "feedback_received", detail: { id, kind: "bug" } }]);
  });

  it("takes one from a paused LUME (a lock screen can have bugs too)", async () => {
    const s = await bound({ suspended: true });
    expect((await post(report(s))).status).toBe(201);
  });

  it("takes one from the holder of a rotated key inside its 7 days, and not after", async () => {
    const s = await bound();
    await db.pool.query("UPDATE licences SET key_hash = $2 WHERE client_id = $1", [
      s.clientId,
      hashKey("LUME-W4NB-8TZC-1KPE-6RDJ-3VXA"),
    ]);
    await retire(s, "rotated");
    expect((await post(report(s))).status).toBe(201);
    now = new Date(now.getTime() + ROTATE_OVERLAP_MS);
    const late = await post(report(s));
    expect([late.status, await code(late)]).toEqual([403, "KEY_DECOMMISSIONED"]);
  });

  it("refuses another install, a released key, a decommissioned key or client, an unknown key — and binds nothing", async () => {
    const s = await bound();
    const other = await post(report({ ...s, installId: randomUUID() }));
    expect([other.status, await code(other)]).toEqual([409, "KEY_IN_USE"]);

    const r = await bound();
    await db.pool.query(
      "UPDATE licences SET install_id = NULL, activated_at = NULL, released_at = now() WHERE client_id = $1",
      [r.clientId],
    );
    const released = await post(report(r));
    expect([released.status, await code(released)]).toEqual([409, "KEY_IN_USE"]);
    const after = await db.pool.query("SELECT install_id FROM licences WHERE client_id = $1", [r.clientId]);
    expect(after.rows[0].install_id).toBeNull();

    const d = await bound();
    await db.pool.query(
      "UPDATE licences SET key_hash = $2, key_dead_at = now(), install_id = NULL WHERE client_id = $1",
      [d.clientId, hashKey("LUME-DEAD-DEAD-DEAD-DEAD-DEAD")],
    );
    await retire(d, "decommissioned");
    const dead = await post(report(d));
    expect([dead.status, await code(dead)]).toEqual([403, "KEY_DECOMMISSIONED"]);

    const gone = await bound({ decommissioned: true });
    const goneR = await post(report(gone));
    expect([goneR.status, await code(goneR)]).toEqual([403, "KEY_DECOMMISSIONED"]);

    const unknown = await post(report({ ...s, licenseKey: "LUME-AAAA-BBBB-CCCC-DDDD-EEEE" }));
    expect([unknown.status, await code(unknown)]).toEqual([401, "UNAUTHORIZED"]);
    const none = await post(report({ ...s, instanceId: "LUME-NONE-NONE" }));
    expect([none.status, await code(none)]).toEqual([401, "UNAUTHORIZED"]);
    const kept = await db.pool.query("SELECT count(*)::int AS n FROM feedback WHERE client_id = ANY($1)", [
      [s.clientId, r.clientId, d.clientId, gone.clientId],
    ]);
    expect(kept.rows[0].n).toBe(0);
  });

  it("checks every screenshot again, and names the one it refuses", async () => {
    const s = await bound();
    const bad = await post(
      report(s, {
        images: [
          { type: "image/webp", data: b64(testWebp(800, 600)) },
          { type: "image/webp", data: b64(testWebp(4000, 2000)) },
        ],
      }),
    );
    expect(bad.status).toBe(422);
    expect(((await bad.json()) as { error: object }).error).toMatchObject({
      code: "FEEDBACK_IMAGE_REFUSED",
      index: 1,
    });
    // A WebP that says it's a JPEG is refused too.
    const lies = await post(report(s, { images: [{ type: "image/jpeg", data: b64(testWebp(800, 600)) }] }));
    expect(lies.status).toBe(422);
  });

  it("holds a report to its limits: text, kind, six images, the page, the theme, nothing extra", async () => {
    const s = await bound();
    const six = Array.from({ length: 6 }, () => ({ type: "image/webp", data: b64(testWebp(10, 10)) }));
    for (const over of [
      { text: "   " },
      { text: "x".repeat(4001) },
      { kind: "rant" },
      { images: six },
      { page: "https://evil.example" },
      { page: "//evil.example" },
      { theme: "sepia" },
      { extra: 1 },
    ])
      expect((await post(report(s, over))).status, JSON.stringify(Object.keys(over))).toBe(400);
    expect((await post(report(s, { text: "x".repeat(4000) }))).status).toBe(201);
    expect((await post("not json")).status).toBe(400);
  });

  it("refuses a body over 12 MB before reading it all", async () => {
    const s = await bound();
    const r = await post(JSON.stringify(report(s, { text: "x".repeat(12 * 1024 * 1024) })));
    expect(r.status).toBe(413);
  });

  it("takes 30 an hour from one install and 60 from one address", async () => {
    const s = await bound();
    const light = report(s, { images: [] });
    for (let i = 0; i < 30; i++) expect((await post(light, `198.51.100.${(i % 5) + 1}`)).status).toBe(201);
    const limited = await post(light, "198.51.100.99");
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);

    ctx = testCtx(db.pool, () => now);
    for (let i = 0; i < 60; i++) {
      const c = await bound();
      expect((await post(report(c, { images: [] }), "203.0.113.77")).status).toBe(201);
    }
    const c = await bound();
    expect((await post(report(c, { images: [] }), "203.0.113.77")).status).toBe(429);
  });
});
