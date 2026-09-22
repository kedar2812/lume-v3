// Phase 1B live acceptance (configuration & leads): drives a freshly started stack through Caddy exactly as a browser would.
// Needs a stack with zero users (the API then prints a setup token) and Mailpit (compose.dev.yml).
//
//   SETUP_TOKEN=… LUME_URL=https://lume.localhost:8443 MAILPIT_URL=http://127.0.0.1:8025 \
//     node infra/scripts/acceptance-1b.mjs
//
// Dev only: trusts Caddy's internal CA (NODE_TLS_REJECT_UNAUTHORIZED=0 is set by the caller).
import { createHmac, randomBytes } from "node:crypto";

const BASE = process.env.LUME_URL ?? "https://lume.localhost:8443";
const MAILPIT = process.env.MAILPIT_URL ?? "http://127.0.0.1:8025";
const SETUP_TOKEN = process.env.SETUP_TOKEN;
if (!SETUP_TOKEN) throw new Error("SETUP_TOKEN is required");

const ok = (msg) => console.log(`ok   ${msg}`);
function assert(cond, msg, detail) {
  if (!cond) {
    console.error(`FAIL ${msg}${detail === undefined ? "" : `\n     ${JSON.stringify(detail)}`}`);
    process.exit(1);
  }
  ok(msg);
}

// RFC 6238 TOTP (same algorithm as packages/core/src/auth/totp.ts), for the authenticator-app step.
function base32Decode(s) {
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of s.replace(/=+$/, "")) {
    value = (value << 5) | A.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}
function totp(secret, atMs = Date.now()) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(Math.floor(atMs / 30_000)));
  const mac = createHmac("sha1", base32Decode(secret)).update(msg).digest();
  const o = mac[mac.length - 1] & 15;
  return String((mac.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}

/** A browser: its own cookie jar, and the CSRF double-submit header on every state change. */
function browser(name) {
  const jar = new Map();
  async function call(method, path, body, idempotencyKey) {
    const headers = { origin: new URL(BASE).origin, "sec-fetch-site": "same-origin" };
    if (jar.size) headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
    if (jar.has("__Host-lume_csrf")) headers["x-csrf-token"] = jar.get("__Host-lume_csrf");
    if (body !== undefined) headers["content-type"] = "application/json";
    if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;
    const res = await fetch(BASE + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const c of res.headers.getSetCookie()) {
      const [pair, ...attrs] = c.split(";");
      const [k, v] = pair.split("=");
      const expired = attrs.some((a) => /expires=thu, 01 jan 1970/i.test(a.trim()));
      if (expired || v === "") jar.delete(k.trim());
      else jar.set(k.trim(), v.trim());
    }
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  }
  return {
    name,
    get: (p) => call("GET", p),
    post: (p, b, key) => call("POST", p, b ?? {}, key),
    patch: (p, b) => call("PATCH", p, b),
    async start() {
      await call("GET", "/api/v1/auth/csrf");
    },
  };
}

const owner = browser("owner");
await owner.start();

// 1. First run with Nupuur's preset
const setupSecret = (await owner.post("/api/v1/setup/totp", { token: SETUP_TOKEN })).body.secret;
let r = await owner.post("/api/v1/setup", {
  token: SETUP_TOKEN,
  business: { name: "Nupuur Coaching", timezone: "Asia/Dubai", currency: "AED", defaultCountry: "AE" },
  preset: "coaching",
  owner: { name: "Nupuur Patil", email: "owner@nupuur.local", password: `acceptance ${randomBytes(6).toString("hex")} passphrase` },
  totp: { secret: setupSecret, code: totp(setupSecret) },
});
assert(r.status === 201, "setup with the Coaching preset", r.body);
const pipelines = (await owner.get("/api/v1/pipelines")).body.pipelines;
const stages = Object.fromEntries(pipelines[0].stages.map((s) => [s.name, s.id]));
assert(
  pipelines.length === 1 && pipelines[0].stages.map((s) => s.name).join(",") === "New,Message sent,Replied,Call booked,Call done,Follow-up later,Won,Lost",
  "the preset seeded Nupuur's pipeline and stages",
);
const fieldKeys = (await owner.get("/api/v1/fields")).body.fields.map((f) => f.key);
assert(fieldKeys.includes("struggles") && fieldKeys.includes("handled_by"), "the preset seeded Struggles and Handled by");

// 2. Riya joins as Sales
const sales = (await owner.get("/api/v1/roles")).body.roles.find((x) => x.name === "Sales");
const riyaEmail = `riya+${randomBytes(3).toString("hex")}@nupuur.local`;
r = await owner.post("/api/v1/invites", { email: riyaEmail, name: "Riya", roleIds: [sales.id] });
assert(r.status === 201, "owner invites Riya as Sales");
let link = null;
for (let i = 0; i < 30 && !link; i++) {
  const list = await (await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${riyaEmail}"`)}`)).json();
  if (list.messages?.length) {
    const msg = await (await fetch(`${MAILPIT}/api/v1/message/${list.messages[0].ID}`)).json();
    link = /https:\/\/\S+\/invite\/([A-Za-z0-9_-]{43})/.exec(msg.Text)?.[1] ?? null;
  } else await new Promise((res) => setTimeout(res, 200));
}
const riya = browser("riya");
await riya.start();
assert((await riya.post(`/api/v1/invites/${link}/accept`, { password: "sunrise over the creek at five" })).status === 201, "Riya accepts the invite");
const riyaId = (await owner.get("/api/v1/users")).body.users.find((u) => u.email === riyaEmail).id;

// 3. The owner creates a lead for Riya: the local number is normalised with the business's country
r = await owner.post("/api/v1/leads", { name: "Asha Menon", phone: "050 123 4567", email: "asha@example.com", ownerId: riyaId }, "key-accept-lead-0001");
assert(r.status === 201 && r.body.lead.phone.display === "+971 50 123 4567" && !r.body.lead.phone.masked, "owner creates a lead and sees the full, normalised number", r.body);
const asha = r.body.lead.id;
const replay = await owner.post("/api/v1/leads", { name: "Asha Menon", phone: "050 123 4567", email: "asha@example.com", ownerId: riyaId }, "key-accept-lead-0001");
assert(replay.status === 201 && replay.body.lead.id === asha, "a retried create with the same Idempotency-Key replays instead of duplicating");

// 4. Riya sees only her lead, with contacts masked
r = await riya.get("/api/v1/leads");
assert(r.status === 200 && r.body.items.length === 1 && r.body.items[0].id === asha, "Riya's list holds exactly her lead");
assert(r.body.items[0].phone.display === "+971 50 ••• ••67" && r.body.items[0].phone.masked, "…with the phone masked");
assert(r.body.items[0].email.display === "a•••@example.com", "…and the email masked");
assert((await riya.get("/api/v1/leads?q=1234567")).body.items.length === 0, "Riya can't search by phone digits");

// 5. Reveal: one lead, audited and metered
r = await riya.post(`/api/v1/leads/${asha}/contact/reveal`);
assert(r.status === 200 && r.body.phone === "+971 50 123 4567" && r.body.email === "asha@example.com", "Reveal shows Riya the full contact", r.body);
const audit1 = (await owner.get("/api/v1/audit?limit=100")).body.entries;
assert(audit1.some((e) => e.action === "lead.contact.reveal" && e.entityId === asha), "the reveal is in the audit log");

// 6. Riya moves the lead along
r = await riya.post(`/api/v1/leads/${asha}/stage`, { stageId: stages["Call booked"] });
assert(r.status === 200 && r.body.lead.stageId === stages["Call booked"] && r.body.lead.version === 2, "Riya moves the lead to Call booked");
r = await riya.post(`/api/v1/leads/${asha}/stage`, { stageId: stages.Lost });
assert(r.status === 400 && r.body.error.code === "LOST_REASON_REQUIRED", "Lost needs a reason");
const acts = (await riya.get(`/api/v1/leads/${asha}/activities`)).body.items.map((a) => a.type);
assert(acts.includes("stage_changed") && acts.includes("contact_revealed") && acts.includes("lead_created"), "the timeline records it all", acts);

// 7. Someone else's lead doesn't exist for Riya
r = await owner.post("/api/v1/leads", { name: "Owner's own lead" });
const ownersLead = r.body.lead.id;
r = await riya.get(`/api/v1/leads/${ownersLead}`);
assert(r.status === 404 && r.body.error.code === "LEAD_NOT_FOUND", "Riya gets 404 for the owner's lead");
assert((await riya.post(`/api/v1/leads/${ownersLead}/contact/reveal`)).status === 404, "…and can't reveal it");

// 8. Reassignment takes Riya's access away immediately
r = await owner.post(`/api/v1/leads/${asha}/assign`, { ownerId: (await owner.get("/api/v1/auth/me")).body.user.id, reason: "acceptance" });
assert(r.status === 200, "owner takes the lead back", r.body);
assert((await riya.get(`/api/v1/leads/${asha}`)).status === 404, "Riya lost the lead at once");
assert((await riya.get("/api/v1/leads")).body.items.length === 0, "…and her list is empty");

// 9. Disabling Riya ends her session
assert((await owner.post(`/api/v1/users/${riyaId}/disable`)).status === 204, "owner disables Riya");
assert((await riya.get("/api/v1/leads")).status === 401, "Riya's session is dead");

console.log("acceptance 1B passed");
