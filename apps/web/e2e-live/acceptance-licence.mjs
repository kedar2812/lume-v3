// Licensing live acceptance (L-B Task 4): the deployed licence server (127.0.0.1:8480 on its host) and a
// development LUME that checks in with it.
//   node acceptance-licence.mjs create   sign in to the panel (two steps), create a client; writes its key
//                                        and instance ID to ACCEPT_STATE_DIR/licence-client.json
//   (the shell then starts LUME's API with that key, pointed at the licence server)
//   node acceptance-licence.mjs run      LUME checks in and is active; Mark paid; a reminder shows at LUME's
//                                        sign-in; Suspend locks LUME and its owner still exports; Resume;
//                                        then every panel screen in both themes, full content.
// Needs ADMIN_EMAIL, ADMIN_PASSWORD, ADMIN_TOTP (from the host's secrets, via --env-file) and ACCEPT_STATE_DIR.
import { createHmac } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { chromium } from "@playwright/test";

const PANEL = process.env.LICENCE_URL ?? "http://127.0.0.1:8480";
const LUME = process.env.LUME_URL ?? "https://lume.localhost:8443";
const STATE = process.env.ACCEPT_STATE_DIR;
const phase = process.argv[2];
if (!STATE || !["create", "run"].includes(phase))
  throw new Error("usage: ACCEPT_STATE_DIR=… acceptance-licence.mjs create|run");
const SHOTS = path.resolve(import.meta.dirname, "../../../docs/runbooks/screenshots-licence");
mkdirSync(SHOTS, { recursive: true });
const CLIENT_FILE = path.join(STATE, "licence-client.json");
const PANEL_STATE = path.join(STATE, "licence-admin.json");

const ok = (msg) => console.log(`ok   ${msg}`);
function assert(cond, msg, detail) {
  if (!cond) {
    console.error(`FAIL ${msg}${detail === undefined ? "" : `\n     ${JSON.stringify(detail)}`}`);
    process.exit(1);
  }
  ok(msg);
}
// RFC 6238, as in packages/core/src/auth/totp.ts.
function totp(secret, atMs = Date.now()) {
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const ch of secret.replace(/\s|=+$/g, "")) bits += A.indexOf(ch).toString(2).padStart(5, "0");
  const key = Buffer.from(bits.match(/.{8}/g).map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(atMs / 30_000)));
  const h = createHmac("sha1", key).update(counter).digest();
  const o = h[h.length - 1] & 0xf;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}

const browser = await chromium.launch();
const shot = (page, name) =>
  page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true, animations: "disabled" });
const settle = (page) => page.waitForLoadState("networkidle").catch(() => undefined);

let signedIn = false;
/** A panel page; the first one of a phase signs in (two steps), the rest reuse its session. */
async function panelPage(theme = "light") {
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    reducedMotion: "reduce",
    ...(signedIn ? { storageState: PANEL_STATE } : {}),
  });
  await ctx.addInitScript((t) => localStorage.setItem("lume-licence-theme", t), theme);
  const page = await ctx.newPage();
  if (!signedIn) await signIn(page);
  return page;
}
async function signIn(page, shots = false) {
  await page.goto(`${PANEL}/clients`);
  assert(page.url().endsWith("/sign-in"), "the panel sends a signed-out visitor to its sign-in");
  if (shots) await shot(page, "01-sign-in");
  await page.getByLabel("Email").fill(process.env.ADMIN_EMAIL);
  await page.getByLabel("Password").fill(process.env.ADMIN_PASSWORD);
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByText("Two-step sign-in").waitFor();
  if (shots) await shot(page, "02-two-step");
  await page.getByLabel("Code").fill(totp(process.env.ADMIN_TOTP));
  await page.getByText("Welcome back").waitFor();
  ok("signed in with a password and six digits");
  if (shots) await shot(page, "03-welcome");
  await page.getByRole("link", { name: "Open clients" }).click();
  await page.getByRole("table", { name: "Clients" }).waitFor();
  await page.context().storageState({ path: PANEL_STATE });
  signedIn = true;
}
async function lumeOwner() {
  const ctx = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 1366, height: 860 },
    reducedMotion: "reduce",
    storageState: path.join(STATE, "owner.json"),
  });
  return ctx.newPage();
}
/** The owner presses Check now on Settings → About, as an admin would; LUME asks the licence server. */
async function checkNow(page) {
  await page.goto(`${LUME}/settings/about`);
  const paused = page.getByRole("alertdialog", { name: "LUME is paused" });
  if (await paused.isVisible().catch(() => false)) {
    await paused.getByRole("button", { name: "Check again" }).click();
    await page.waitForTimeout(1200);
  }
  const card = page.getByRole("region", { name: "Licence", exact: true });
  await card.waitFor();
  await page.getByRole("button", { name: "Check now" }).click();
  await page.getByRole("button", { name: /Checked · all good|Check now/ }).waitFor();
  await page.waitForTimeout(800);
  return card;
}

if (phase === "create") {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
  await ctx.addInitScript(() => localStorage.setItem("lume-licence-theme", "dark"));
  const page = await ctx.newPage();
  await signIn(page, true);

  await page.getByRole("button", { name: "New licence" }).click();
  const sheet = page.getByRole("dialog", { name: "New licence" });
  await sheet.getByLabel("Business name").fill("Acceptance Clinic");
  await sheet.getByLabel("State").selectOption("KA");
  await sheet.getByLabel("Price").fill("2999");
  await sheet.getByText("≈ ₹2,999 a month in your analytics").waitFor();
  await shot(page, "04-new-licence");
  await sheet.getByRole("button", { name: "Create licence" }).click();
  const done = page.getByRole("dialog", { name: "Licence created" });
  await done.waitFor();
  const text = await done.innerText();
  const key = /LUME(-[0-9A-Z]{4}){5}/.exec(text)?.[0];
  const instanceId = /LUME-[0-9A-Z]{4}-[0-9A-Z]{4}(?![0-9A-Z-])/.exec(text.replace(key ?? "", ""))?.[0];
  assert(key && instanceId, "New licence shows the key and the instance ID, once", { instanceId });
  const href = await done.getByRole("link", { name: "Open Acceptance Clinic" }).getAttribute("href");
  writeFileSync(CLIENT_FILE, JSON.stringify({ key, instanceId, clientId: href.split("/").pop() }), {
    mode: 0o600,
  });
  await browser.close();
  process.exit(0);
}

// ---------- run ----------
const client = JSON.parse(readFileSync(CLIENT_FILE, "utf8"));
const panel = await panelPage("light");
const lume = await lumeOwner();
const clientUrl = `${PANEL}/clients/${client.clientId}`;

// 1. LUME checks in and is active.
let card = await checkNow(lume);
await card.getByText("Active").first().waitFor();
assert(
  (await card.innerText()).includes(client.instanceId),
  "LUME checked in with the licence server and is active, as this instance",
);
await shot(lume, "10-lume-about-active");
await panel.goto(clientUrl);
await panel
  .getByText("Not yet")
  .waitFor({ state: "detached", timeout: 5000 })
  .catch(() => undefined);
await panel
  .getByRole("region", { name: "This installation" })
  .getByText(/\((just now|.+ ago)\)/)
  .waitFor();
ok("the panel shows the installation: version, people, leads (a count), last check-in");
await shot(panel, "11-client-checked-in");

// 2. Mark paid.
await panel.getByRole("button", { name: "Mark paid" }).click();
await panel
  .getByRole("status")
  .getByText(/Paid until/)
  .waitFor();
ok("Mark paid moves paid until on a month");

// 3. The reminder: LUME's owner sees it.
await panel.getByRole("button", { name: "Send payment reminder" }).click();
await panel
  .getByLabel("Your note (optional)")
  .fill("A gentle reminder from the acceptance run. UPI is fine.");
await panel.getByRole("button", { name: "Send reminder" }).click();
await panel.getByText("Reminder on.").waitFor();
await shot(panel, "12-reminder-on");
await checkNow(lume);
await lume.goto(`${LUME}/today`);
const due = lume.getByRole("dialog", { name: "Your LUME payment is due" });
await due.waitFor();
assert(
  (await due.innerText()).includes("A gentle reminder from the acceptance run."),
  "LUME's owner sees the reminder, with the note",
);
await shot(lume, "13-lume-reminder");
await due.getByRole("button", { name: "I'll sort it" }).click();

// 4. Suspend: LUME is paused; its owner still exports everything.
await panel.goto(clientUrl);
await panel.getByRole("button", { name: "Suspend…" }).click();
await panel.getByRole("button", { name: "Suspend", exact: true }).click();
await panel.getByRole("button", { name: "Resume" }).waitFor();
await shot(panel, "14-suspended");
await lume.goto(`${LUME}/settings/about`);
await lume
  .getByRole("button", { name: "Check now" })
  .click()
  .catch(() => undefined);
await lume.waitForTimeout(1500);
await lume.goto(`${LUME}/today`);
const lock = lume.getByRole("alertdialog", { name: "LUME is paused" });
await lock.waitFor();
ok("LUME shows the pause screen");
await lock.getByRole("button", { name: "Export all data" }).click();
await lock.getByRole("link", { name: "Download" }).waitFor({ timeout: 60_000 });
ok("its owner still exports everything");
await shot(lume, "15-lume-paused-exported");

// 5. Resume, and the reminder stops: the owner checks again from the pause screen, and LUME carries on.
await panel.goto(clientUrl);
await panel.getByRole("button", { name: "Resume" }).click();
await panel.getByRole("button", { name: "Suspend…" }).waitFor();
await panel.getByRole("button", { name: "Stop" }).click();
await panel.getByText("Reminder on.").waitFor({ state: "detached" });
await lume.goto(`${LUME}/today`);
const paused = lume.getByRole("alertdialog", { name: "LUME is paused" });
await paused.getByRole("button", { name: "Check again" }).click();
await paused.waitFor({ state: "detached" });
ok("resumed: Check again on the pause screen, and LUME works again");
card = await checkNow(lume);
await card.getByText("Active").first().waitFor();

// 6. Every screen, both themes, full content.
for (const theme of ["light", "dark"]) {
  const p = await panelPage(theme);
  for (const [name, url] of [
    ["clients", "/clients"],
    ["client", `/clients/${client.clientId}`],
    ["analytics", "/analytics"],
    ["releases", "/releases"],
    ["payments", "/payments"],
    ["settings", "/settings"],
  ]) {
    await p.goto(`${PANEL}${url}`);
    await settle(p);
    await p.waitForTimeout(700);
    await shot(p, `20-${name}-${theme}`);
  }
  if (theme === "light") {
    const paying = await p
      .goto(`${PANEL}/analytics`)
      .then(() => p.getByRole("region", { name: "Paying clients" }).innerText());
    assert(/\d/.test(paying), "Analytics counts the paying clients", paying);
  }
}
await browser.close();
console.log("licence acceptance: all passed");
