import { generateKeyPairSync } from "node:crypto";
import { ALL_GRANTS, rawPublicKey, testJpeg, testWebp } from "@lume/core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHarness, type AuthedClient, type Harness } from "../../../test/harness";

/**
 * Send feedback (spec 2026-10-16 §1.4): checked here, forwarded at once to the licence server under this install's
 * key, kept nowhere but an audit line.
 */
const server = generateKeyPairSync("ed25519");
const KEY = "LUME-7K2P-Q9XD-4MRT-H8VC-7Q2K";
const INSTANCE = "LUME-H4RB-8C2L";
let h: Harness;
type Answer = () => Promise<Response> | Response;
let answer: Answer;
const sent: { url: string; body: Record<string, unknown> }[] = [];
const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
  sent.push({ url: String(url), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
  return answer();
}) as typeof fetch;
const b64 = (u: Uint8Array) => Buffer.from(u).toString("base64");
const report = (over: Record<string, unknown> = {}) => ({
  kind: "bug",
  text: "  I dragged a lead to Meeting set and it jumped back.  ",
  page: "/leads?q=Ananya%20Rao#top",
  theme: "obsidian",
  screen: "1536 × 864 · 1.25×",
  images: [{ type: "image/webp", data: b64(testWebp(1920, 1080)) }],
  ...over,
});
const created = () => new Response(JSON.stringify({ id: "f1" }), { status: 201 });

let rep: AuthedClient;
let owner: AuthedClient;
beforeAll(async () => {
  h = await createHarness({
    licence: {
      mode: "enforce",
      instanceId: INSTANCE,
      licenseKey: KEY,
      url: "https://licence.test",
      keys: { t1: rawPublicKey(server.publicKey) },
      version: "1.5.0",
      fetch: fakeFetch,
    },
  });
  const r = await h.seedUser({
    name: "Priya Shah",
    email: "priya@harbour.example",
    grants: [{ key: "leads.view", scope: "own" }],
  });
  await h.ownerPool.query(
    "UPDATE roles SET name = 'Sales rep' WHERE id = (SELECT role_id FROM user_roles WHERE user_id = $1)",
    [r.id],
  );
  rep = await h.signIn(r);
  owner = await h.signIn(
    await h.seedUser({ owner: true, grants: ALL_GRANTS, totp: true, name: "Asha Pillai" }),
  );
});
afterAll(() => h.close());
beforeEach(() => {
  sent.length = 0;
  answer = created;
});
const send = (c: AuthedClient, body: unknown, headers: Record<string, string> = {}) =>
  c.inject({
    method: "POST",
    url: "/api/v1/feedback",
    payload: body as object,
    headers: { "user-agent": "Mozilla/5.0 (Windows NT 10.0) Chrome/141.0.0.0", ...headers },
  });
const toLicence = () => sent.filter((s) => s.url === "https://licence.test/v1/feedback");

describe("POST /api/v1/feedback", () => {
  it("forwards the report under the install's key, the person from the session, the page without its search", async () => {
    const claims = await send(rep, {
      ...report(),
      reporter: { name: "Someone Else", email: "x@y.z", role: "Owner" },
    });
    expect(claims.statusCode).toBe(400); // a body may not say who sent it
    const ok = await send(rep, report());
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json()).toEqual({ ok: true });
    const [s] = toLicence();
    expect(s!.body).toMatchObject({
      instanceId: INSTANCE,
      licenseKey: KEY,
      appVersion: "1.5.0",
      browser: "Mozilla/5.0 (Windows NT 10.0) Chrome/141.0.0.0",
      reporter: { name: "Priya Shah", email: "priya@harbour.example", role: "Sales rep" },
      kind: "bug",
      text: "I dragged a lead to Meeting set and it jumped back.",
      page: "/leads",
      theme: "obsidian",
      screen: "1536 × 864 · 1.25×",
    });
    expect(typeof s!.body.installId).toBe("string");
    expect(s!.body.images).toEqual([{ type: "image/webp", data: b64(testWebp(1920, 1080)) }]);
  });

  it("says Owner for the owner", async () => {
    expect((await send(owner, report({ images: [] }))).statusCode).toBe(200);
    expect(toLicence()[0]!.body.reporter).toMatchObject({ name: "Asha Pillai", role: "Owner" });
  });

  it("keeps nothing but an audit line with the kind and how many screenshots — never the words or the key", async () => {
    await send(owner, report({ text: "secret-words-123" }));
    const a = await h.ownerPool.query<{ diff: unknown }>(
      "SELECT diff FROM audit_log WHERE action = 'feedback.sent' ORDER BY id DESC LIMIT 1",
    );
    expect(a.rows[0]!.diff).toEqual({ kind: "bug", images: 1 });
    const all = JSON.stringify((await h.ownerPool.query("SELECT * FROM audit_log")).rows);
    expect(all).not.toContain("secret-words-123");
    expect(all).not.toContain(KEY);
  });

  it("refuses a screenshot that isn't what it says, naming it, before asking the licence server", async () => {
    const r = await send(
      owner,
      report({
        images: [
          { type: "image/webp", data: b64(testWebp(10, 10)) },
          { type: "image/jpeg", data: b64(testWebp(10, 10)) },
        ],
      }),
    );
    expect(r.statusCode).toBe(422);
    expect(r.json().error).toMatchObject({ code: "FEEDBACK_IMAGE_REFUSED", details: { index: 1 } });
    expect(toLicence()).toHaveLength(0);
  });

  it("holds the report to its limits", async () => {
    const six = Array(6).fill({ type: "image/jpeg", data: b64(testJpeg(10, 10)) });
    for (const over of [
      { text: "" },
      { text: "  " },
      { text: "x".repeat(4001) },
      { kind: "rant" },
      { theme: "sepia" },
      { images: six },
    ])
      expect((await send(owner, report(over))).statusCode, JSON.stringify(Object.keys(over))).toBe(400);
    expect(toLicence()).toHaveLength(0);
  });

  it("cuts a long browser, name and role rather than refusing them", async () => {
    const long = await h.seedUser({
      name: "N".repeat(200),
      email: "long@harbour.example",
      grants: [{ key: "leads.view", scope: "own" }],
    });
    await h.ownerPool.query(
      "UPDATE roles SET name = $2 WHERE id = (SELECT role_id FROM user_roles WHERE user_id = $1)",
      [long.id, "R".repeat(90)],
    );
    const c = await h.signIn(long);
    expect((await send(c, report({ images: [] }), { "user-agent": "U".repeat(500) })).statusCode).toBe(200);
    const b = toLicence()[0]!.body as { browser: string; reporter: { name: string; role: string } };
    expect(b.browser).toHaveLength(300);
    expect(b.reporter.name.length).toBeLessThanOrEqual(120);
    expect(b.reporter.role).toHaveLength(60);
    expect(b.reporter.role.endsWith("…")).toBe(true);
  });

  it("says each licence-server answer in its own way", async () => {
    const limited = () =>
      new Response(JSON.stringify({ error: { code: "RATE_LIMITED" } }), {
        status: 429,
        headers: { "retry-after": "1440" },
      });
    const refused =
      (status: number, code: string, extra: object = {}) =>
      () =>
        new Response(JSON.stringify({ error: { code, ...extra } }), { status });
    const cases: [Answer, number, string][] = [
      [
        () => Promise.reject(Object.assign(new Error("timeout"), { name: "TimeoutError" })),
        503,
        "FEEDBACK_UNREACHABLE",
      ],
      [() => new Response("{}", { status: 502 }), 503, "FEEDBACK_UNREACHABLE"],
      [limited, 429, "FEEDBACK_LIMITED"],
      [refused(422, "FEEDBACK_IMAGE_REFUSED", { index: 0 }), 422, "FEEDBACK_IMAGE_REFUSED"],
      [refused(409, "KEY_IN_USE"), 409, "FEEDBACK_LICENCE"],
      [refused(403, "KEY_DECOMMISSIONED"), 409, "FEEDBACK_LICENCE"],
      [refused(401, "UNAUTHORIZED"), 409, "FEEDBACK_LICENCE"],
    ];
    for (const [a, status, code] of cases) {
      answer = a;
      const r = await send(owner, report({ images: [] }));
      expect([r.statusCode, r.json().error.code]).toEqual([status, code]);
    }
    answer = limited;
    expect((await send(owner, report({ images: [] }))).json().error.details).toEqual({ retryAfterSec: 1440 });
    answer = refused(422, "FEEDBACK_IMAGE_REFUSED", { index: 0 });
    expect((await send(owner, report())).json().error.details).toEqual({ index: 0 });
  });

  it("lets a person send ten an hour; a try that didn't reach LUME's team doesn't count", async () => {
    const p = await h.signIn(
      await h.seedUser({
        name: "Omar Farooq",
        email: "omar@harbour.example",
        grants: [{ key: "leads.view", scope: "own" }],
      }),
    );
    answer = () => Promise.reject(new Error("down"));
    for (let i = 0; i < 3; i++) expect((await send(p, report({ images: [] }))).statusCode).toBe(503);
    answer = created;
    for (let i = 0; i < 10; i++) expect((await send(p, report({ images: [] }))).statusCode).toBe(200);
    const r = await send(p, report({ images: [] }));
    expect(r.statusCode).toBe(429);
    expect(r.json().error.code).toBe("FEEDBACK_LIMITED");
    expect(r.json().error.details.retryAfterSec).toBeGreaterThan(0);
  });

  it("the licence says this LUME can send feedback", async () => {
    expect((await owner.inject({ method: "GET", url: "/api/v1/licence" })).json().feedback).toBe(true);
  });
});
