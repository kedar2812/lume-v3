// Phase 1C-1 live acceptance: a real Chromium walks the six steps of the plan against the running dev
// stack, through Caddy's TLS, with mail read from Mailpit. Screenshots go to docs/runbooks/screenshots-1c1
// with every secret (QR codes, TOTP keys, recovery codes) masked.
//
//   SETUP_TOKEN=… node apps/web/e2e-live/acceptance-1c1.mjs     (run with --network host on the build host)
//
// Dev only: trusts Caddy's internal CA. The accounts it creates are throwaway; the database is reset after.
import { createHmac, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { chromium } from "@playwright/test";

const BASE = process.env.LUME_URL ?? "https://lume.localhost:8443";
const MAILPIT = process.env.MAILPIT_URL ?? "http://127.0.0.1:8025";
const TOKEN = process.env.SETUP_TOKEN;
if (!TOKEN) throw new Error("SETUP_TOKEN is required");
const SHOTS = path.resolve(import.meta.dirname, "../../../docs/runbooks/screenshots-1c1");
mkdirSync(SHOTS, { recursive: true });

const ok = (msg) => console.log(`ok   ${msg}`);
function assert(cond, msg, detail) {
  if (!cond) {
    console.error(`FAIL ${msg}${detail === undefined ? "" : `\n     ${JSON.stringify(detail)}`}`);
    process.exit(1);
  }
  ok(msg);
}

// RFC 6238, as in packages/core/src/auth/totp.ts.
function totp(secret) {
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of secret.replace(/\s|=+$/g, "")) {
    value = (value << 5) | A.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
  const h = createHmac("sha1", Buffer.from(out)).update(counter).digest();
  const o = h[h.length - 1] & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}

const pw = () => `accept ${randomBytes(9).toString("base64url")} passphrase`;
const OWNER = { name: "Nupuur Patil", email: "nupuur@nupuur.test", password: pw() };
const ADMIN = { name: "Tasneem Shaikh", email: "tasneem@nupuur.test", password: pw() };
const REP = { name: "Riya Sharma", email: "riya@nupuur.test", password: pw() };

async function mailTo(address, kind, since) {
  for (let i = 0; i < 60; i++) {
    const list = await (await fetch(`${MAILPIT}/api/v1/messages?limit=50`)).json();
    const hit = list.messages.find(
      (m) =>
        m.To.some((t) => t.Address === address) &&
        new Date(m.Created) > new Date(since) &&
        m.Subject.toLowerCase().includes(kind),
    );
    if (hit) {
      const full = await (await fetch(`${MAILPIT}/api/v1/message/${hit.ID}`)).json();
      const link = new RegExp(
        `https://[^\\s"<>]*/${kind === "invite" ? "invite" : "reset"}/[A-Za-z0-9_-]+`,
      ).exec(full.Text)?.[0];
      if (link) return { subject: hit.Subject, link };
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`no ${kind} mail for ${address}`);
}

const browser = await chromium.launch();
const newPage = async (theme = "porcelain") => {
  const ctx = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 1366, height: 800 },
    reducedMotion: "reduce",
  });
  await ctx.addCookies([{ name: "lume_theme", value: theme, url: BASE }]);
  const page = await ctx.newPage();
  const goto = page.goto.bind(page);
  page.goto = async (url) => {
    const r = await goto(url.startsWith("http") ? url : `${BASE}${url}`);
    await page.locator("html[data-hydrated]").waitFor({ state: "attached" });
    return r;
  };
  return page;
};
const secrets = (page) => [
  page.getByRole("img", { name: /QR code/ }),
  page.getByTestId("totp-secret"),
  page.getByTestId("recovery-codes"),
  page.locator('[class*="clock"]'),
];
const shot = async (page, name) => {
  await page.waitForTimeout(700);
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), mask: secrets(page) });
};
const code = async (page) => {
  const secret = (await page.getByTestId("totp-secret").innerText()).replace(/\s/g, "");
  await page.getByLabel("Digit 1 of 6").click();
  await page.keyboard.type(totp(secret));
};
/** Skips to the end of onboarding: waits for whichever button is next rather than guessing. */
const skipThrough = async (page) => {
  const explore = page.getByRole("button", { name: /explore on my own/i });
  const skip = page.getByRole("button", { name: /^(Skip|Later)$/ });
  for (let i = 0; i < 12; i++) {
    await explore.or(skip).first().waitFor();
    if (await explore.isVisible()) break;
    await skip.click();
  }
  await explore.click();
  await page.waitForURL(/\/today$/);
};

// 1 ─ first run ────────────────────────────────────────────────────────────────────────────────────
const owner = await newPage();
await owner.goto("/today");
assert(
  owner.url().endsWith("/setup"),
  "a brand-new installation sends every visitor to the setup wizard",
  owner.url(),
);
await owner.getByLabel("Setup token").fill(TOKEN);
await owner.getByRole("button", { name: "Continue" }).click();
await owner.getByLabel("Business name").fill("Nupuur Coaching");
await owner.getByLabel("Timezone").fill("Dubai");
await owner.getByRole("option", { name: /Dubai/ }).first().click();
await shot(owner, "01a-setup-business");
await owner.getByRole("button", { name: "Continue" }).click();
await owner.getByLabel("Your name").fill(OWNER.name);
await owner.getByLabel("Email").fill(OWNER.email);
await owner.getByLabel("Password").fill(OWNER.password);
await owner.getByRole("button", { name: "Continue" }).click();
await shot(owner, "01b-setup-two-step");
await code(owner);
await owner.getByRole("button", { name: "Finish setup" }).click();
await owner.getByTestId("recovery-codes").waitFor();
assert(
  (await owner.getByTestId("recovery-codes").getByRole("listitem").count()) === 10,
  "setup shows ten recovery codes",
);
await shot(owner, "01c-setup-recovery-codes");
await owner.getByRole("checkbox", { name: /saved/i }).check();
await owner.getByRole("button", { name: /open lume/i }).click();
await owner.waitForURL(/\/welcome$/);
ok("the owner lands in onboarding, signed in");

// 2 ─ the owner's onboarding: preferences, team, pipeline ──────────────────────────────────────────
await owner.getByRole("button", { name: /let’s go/i }).click();
await owner.getByRole("button", { name: "Continue" }).click(); // You
await owner.getByRole("radio", { name: /porcelain/i }).click();
await owner.getByRole("button", { name: "Continue" }).click(); // Look
await owner.getByRole("button", { name: "Sat" }).click();
await shot(owner, "02a-onboarding-day");
await owner.getByRole("button", { name: "Continue" }).click(); // Your day
await owner.getByRole("button", { name: "Continue" }).click(); // Alerts
const invitedAt = new Date(Date.now() - 2000).toISOString();
for (const [who, role] of [
  [ADMIN, "Admin"],
  [REP, "Sales"],
]) {
  await owner.getByRole("textbox", { name: "Email" }).fill(who.email);
  await owner.getByRole("textbox", { name: "Name", exact: true }).fill(who.name);
  await owner.getByLabel("Role").selectOption({ label: role });
  await owner.getByRole("button", { name: "Invite" }).click();
  await owner.getByText(who.email).waitFor();
}
assert((await owner.getByText("Invite sent").count()) === 2, "both invites are sent from the Team step");
await shot(owner, "02b-onboarding-team");
await owner.getByRole("button", { name: "Continue" }).click(); // Team
const stageNames = owner.getByRole("textbox", { name: /^Stage \d+ name$/ });
await stageNames.first().waitFor();
const names = [];
for (const box of await stageNames.all()) names.push(await box.inputValue());
assert(
  names.includes("Call booked") && names.length === 8,
  "the Coaching pipeline's eight stages are there to review",
  names,
);
await shot(owner, "02c-onboarding-pipeline");
await owner.getByRole("button", { name: "Looks good" }).click();
await owner.getByRole("heading", { name: /you’re all set/i }).waitFor();
await owner.getByRole("button", { name: /take the tour/i }).click();
await owner.waitForURL(/\/today$/);

// 3 ─ the tour ─────────────────────────────────────────────────────────────────────────────────────
const card = owner.getByRole("dialog", { name: /tour/i });
await card.waitFor();
const blur = await owner
  .getByTestId("tour-veil")
  .evaluate((el) => el.ownerDocument.defaultView.getComputedStyle(el).backdropFilter);
assert(blur.includes("blur"), "the veil really blurs the app (the Chrome glass bug stays fixed)", blur);
await shot(owner, "03a-tour-porcelain");
const ownerSteps = [];
for (let i = 0; i < 30; i++) {
  ownerSteps.push(await card.getByRole("heading").innerText());
  if (await owner.getByRole("button", { name: "Done" }).isVisible()) break;
  await owner.getByRole("button", { name: "Next" }).click();
}
assert(
  ownerSteps.includes("People and roles") && ownerSteps.includes("Audit log"),
  "the owner's tour covers the admin tools",
  ownerSteps,
);
await owner.getByRole("button", { name: "Done" }).click();
await owner.context().addCookies([{ name: "lume_theme", value: "obsidian", url: BASE }]);
await owner.goto("/today?tour=1");
await card.waitFor();
await shot(owner, "03b-tour-obsidian");
await owner.keyboard.press("Escape");
await owner.goto("/settings");
await owner.getByRole("button", { name: /replay the tour/i }).click();
await card.waitFor();
ok("the tour replays from Settings");
await owner.keyboard.press("Escape");

// 4 ─ the admin's invite: two-step sign-in comes first ─────────────────────────────────────────────
const adminMail = await mailTo(ADMIN.email, "invite", invitedAt);
ok(`Tasneem's invite arrived: “${adminMail.subject}”`);
const admin = await newPage();
await admin.goto(adminMail.link);
await admin.getByLabel("Choose a password").fill(ADMIN.password);
await admin.getByRole("button", { name: "Join LUME" }).click();
await admin.waitForURL(/\/welcome$/);
await admin.getByRole("button", { name: /let’s go/i }).click();
await admin.getByRole("button", { name: "Continue" }).click(); // You — saves during enrolment now
await admin.getByRole("heading", { name: "Secure your account" }).waitFor();
assert(
  (await admin.getByRole("button", { name: "Skip" }).count()) === 0,
  "an admin cannot skip two-step sign-in",
);
await shot(admin, "04-admin-two-step");
await code(admin);
await admin.getByRole("button", { name: "Verify" }).click();
await admin.getByTestId("recovery-codes").waitFor();
await admin.getByRole("checkbox", { name: /saved/i }).check();
await admin.getByRole("button", { name: "Continue" }).click();
await skipThrough(admin);
ok("Tasneem is enrolled and in the app");

// 5 ─ the sales rep: her own tour, her own nav ─────────────────────────────────────────────────────
const repMail = await mailTo(REP.email, "invite", invitedAt);
const rep = await newPage();
await rep.goto(repMail.link);
await rep.getByLabel("Choose a password").fill(REP.password);
await rep.getByRole("button", { name: "Join LUME" }).click();
await rep.waitForURL(/\/welcome$/);
await rep.getByRole("button", { name: /let’s go/i }).click();
const tourBtn = rep.getByRole("button", { name: /take the tour/i });
// A rep's steps: You, Look, Your day, Alerts — then All set.
for (const heading of [
  "First, about you",
  "How should LUME look?",
  "Your working day",
  "Alerts and sounds",
]) {
  await rep.getByRole("heading", { name: heading }).waitFor();
  await rep.getByRole("button", { name: "Continue" }).click();
}
await tourBtn.click();
await rep.waitForURL(/\/today$/);
const repCard = rep.getByRole("dialog", { name: /tour/i });
await repCard.waitFor();
const repSteps = [];
for (let i = 0; i < 30; i++) {
  repSteps.push(await repCard.getByRole("heading").innerText());
  if (await rep.getByRole("button", { name: "Done" }).isVisible()) break;
  await rep.getByRole("button", { name: "Next" }).click();
}
assert(
  !repSteps.some((s) => /People and roles|Audit log/.test(s)),
  "Riya's tour has no admin steps",
  repSteps,
);
await rep.getByRole("button", { name: "Done" }).click();
const nav = await rep.getByRole("navigation", { name: "Main" }).getByRole("link").allInnerTexts();
assert(
  nav.includes("Settings") && nav.includes("Leads"),
  "Riya's nav has her sections, Settings included (personal)",
  nav,
);
await shot(rep, "05-rep-today");

// 6 ─ sign out, forgot password, reset, sign in ────────────────────────────────────────────────────
await rep.getByRole("button", { name: /Riya/ }).click();
await rep.getByRole("menuitem", { name: "Sign out" }).click();
await rep.waitForURL(/\/sign-in$/);
const resetAt = new Date(Date.now() - 2000).toISOString();
await rep.getByRole("link", { name: /forgot your password/i }).click();
await rep.getByLabel("Email").fill(REP.email);
await rep.getByRole("button", { name: "Send the link" }).click();
await rep.getByText(/on its way/i).waitFor();
const resetMail = await mailTo(REP.email, "reset", resetAt);
ok(`the reset email arrived: “${resetMail.subject}”`);
await rep.goto(resetMail.link);
const fresh = pw();
await rep.getByLabel("New password").fill(fresh);
await rep.getByRole("button", { name: "Save password" }).click();
await rep.getByText(/sign in with your new password/i).waitFor();
await rep.goto("/sign-in");
await rep.getByLabel("Email").fill(REP.email);
await rep.getByLabel("Password").fill(fresh);
await rep.getByRole("button", { name: "Sign in" }).click();
await rep.waitForURL(/\/today$/);
await shot(rep, "06-rep-signed-in-after-reset");
ok("Riya signs in with the new password");

// Hand the three signed-in sessions to acceptance-1c2.mjs when it runs next, in the same throwaway
// container (the passwords and two-step keys above are random and never written anywhere).
if (process.env.ACCEPT_STATE_DIR) {
  mkdirSync(process.env.ACCEPT_STATE_DIR, { recursive: true });
  for (const [who, page] of [
    ["owner", owner],
    ["admin", admin],
    ["rep", rep],
  ])
    await page.context().storageState({ path: path.join(process.env.ACCEPT_STATE_DIR, `${who}.json`) });
}

await browser.close();
console.log("acceptance 1C-1 passed");
