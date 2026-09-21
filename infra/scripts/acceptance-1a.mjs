// Phase 1A live acceptance: drives a freshly started stack through Caddy exactly as a browser would.
// Needs a stack with zero users (the API then prints a setup token) and Mailpit (compose.dev.yml).
//
//   SETUP_TOKEN=… LUME_URL=https://lume.localhost:8443 MAILPIT_URL=http://127.0.0.1:8025 \
//     node infra/scripts/acceptance-1a.mjs
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
  async function call(method, path, body) {
    const headers = { origin: new URL(BASE).origin, "sec-fetch-site": "same-origin" };
    if (jar.size) headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
    if (jar.has("__Host-lume_csrf")) headers["x-csrf-token"] = jar.get("__Host-lume_csrf");
    if (body !== undefined) headers["content-type"] = "application/json";
    const res = await fetch(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
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
    post: (p, b) => call("POST", p, b ?? {}),
    patch: (p, b) => call("PATCH", p, b),
    async start() {
      await call("GET", "/api/v1/auth/csrf");
    },
  };
}

const ownerEmail = "owner@nupuur.local";
const ownerPassword = `acceptance ${randomBytes(6).toString("hex")} passphrase`;
const owner = browser("owner");
await owner.start();

// 1. First run
let r = await owner.get("/api/v1/setup/status");
assert(r.status === 200 && r.body.needsSetup === true, "setup is needed on a fresh install", r.body);
r = await owner.post("/api/v1/setup/totp", { token: "definitely-not-the-token" });
assert(r.status === 403, "a wrong setup token is refused", r.body);
r = await owner.post("/api/v1/setup/totp", { token: SETUP_TOKEN });
assert(r.status === 200 && /^[A-Z2-7]{32}$/.test(r.body.secret), "setup hands out a TOTP secret");
const secret = r.body.secret;
r = await owner.post("/api/v1/setup", {
  token: SETUP_TOKEN,
  business: { name: "Nupuur Coaching", timezone: "Asia/Dubai", currency: "AED", defaultCountry: "AE" },
  preset: "coaching",
  owner: { name: "Nupuur Patil", email: ownerEmail, password: ownerPassword },
  totp: { secret, code: totp(secret) },
});
assert(r.status === 201 && r.body.recoveryCodes.length === 10, "setup creates the owner with 2FA and 10 recovery codes", r.body);
const recovery = r.body.recoveryCodes;
r = await owner.get("/api/v1/setup/status");
assert(r.body.needsSetup === false, "setup cannot run twice");

// 2. The owner is signed in
r = await owner.get("/api/v1/auth/me");
assert(r.status === 200 && r.body.user.isOwner && r.body.twoFactor.enabled, "owner is signed in with 2FA on", r.body);

// 3. Sign out, then back in: password, then a recovery code (the TOTP step used in setup can't be replayed)
r = await owner.post("/api/v1/auth/logout");
assert(r.status === 204, "owner signs out");
assert((await owner.get("/api/v1/auth/me")).status === 401, "signed out means signed out");
await owner.start();
r = await owner.post("/api/v1/auth/login", { email: ownerEmail, password: "wrong password entirely" });
assert(r.status === 401 && r.body.error.code === "INVALID_CREDENTIALS", "a wrong password is refused generically");
r = await owner.post("/api/v1/auth/login", { email: ownerEmail, password: ownerPassword });
assert(r.status === 200 && r.body.next === "otp", "the right password asks for the second step");
assert((await owner.get("/api/v1/auth/me")).status === 401, "a password alone opens nothing");
r = await owner.post("/api/v1/auth/recovery", { code: recovery[0] });
assert(r.status === 200 && r.body.remaining === 9, "a recovery code completes sign-in (9 left)", r.body);
assert((await owner.get("/api/v1/auth/me")).status === 200, "owner is back in");

// 4. Invite Riya as Sales; the email arrives in Mailpit
const roles = (await owner.get("/api/v1/roles")).body.roles;
const sales = roles.find((x) => x.name === "Sales");
assert(sales && roles.some((x) => x.name === "Admin"), "setup seeded the Admin and Sales roles");
const riyaEmail = `riya+${randomBytes(3).toString("hex")}@nupuur.local`;
r = await owner.post("/api/v1/invites", { email: riyaEmail, name: "Riya", roleIds: [sales.id] });
assert(r.status === 201, "owner invites Riya as Sales", r.body);

let link = null;
for (let i = 0; i < 30 && !link; i++) {
  const list = await (await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${riyaEmail}"`)}`)).json();
  if (list.messages?.length) {
    const msg = await (await fetch(`${MAILPIT}/api/v1/message/${list.messages[0].ID}`)).json();
    link = /https:\/\/\S+\/invite\/([A-Za-z0-9_-]{43})/.exec(msg.Text)?.[1] ?? null;
  } else await new Promise((res) => setTimeout(res, 200));
}
assert(link, "the invite email reached Mailpit with a link");

// 5. Riya accepts in her own browser
const riya = browser("riya");
await riya.start();
r = await riya.get(`/api/v1/invites/${link}`);
assert(r.status === 200 && r.body.email === riyaEmail && r.body.businessName === "Nupuur Coaching", "the invite page knows who it is for");
r = await riya.post(`/api/v1/invites/${link}/accept`, { password: "password123456" });
assert(r.status === 400 && r.body.error.code === "WEAK_PASSWORD", "a breached password is refused", r.body);
r = await riya.post(`/api/v1/invites/${link}/accept`, { password: "sunrise over the creek at five" });
assert(r.status === 201, "Riya accepts the invite");
r = await riya.get("/api/v1/auth/me");
assert(
  r.status === 200 && r.body.permissions.some((p) => p.key === "leads.contact.reveal" && p.scope === "own"),
  "Riya is signed in with Sales access (reveal, own scope)",
  r.body,
);
assert(!r.body.permissions.some((p) => p.key === "leads.contact.full"), "Sales never sees full contacts");
assert((await riya.get("/api/v1/users")).status === 403, "Sales cannot open people admin");
assert((await riya.post(`/api/v1/invites/${link}/accept`, { password: "sunrise over the creek at five" })).status === 404, "an invite works once");

// 6. The owner disables Riya: her session ends on the very next request
const riyaId = (await owner.get("/api/v1/users")).body.users.find((u) => u.email === riyaEmail).id;
r = await owner.post(`/api/v1/users/${riyaId}/disable`);
assert(r.status === 204, "owner disables Riya");
assert((await riya.get("/api/v1/auth/me")).status === 401, "Riya's session is dead immediately");

// 7. It is all in the audit log
const actions = new Set((await owner.get("/api/v1/audit?limit=100")).body.entries.map((e) => e.action));
for (const a of ["setup.completed", "user.logout", "user.login.failed", "user.login", "user.invited", "user.invite.accepted", "user.disabled"]) {
  assert(actions.has(a), `audit log records ${a}`);
}

console.log("acceptance 1A passed");
