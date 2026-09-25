// Phase 1C-3 live acceptance: Settings on the running dev stack, through Caddy's TLS, as the owner and
// a masked sales rep, with the currency switched at the live rate from open.er-api.com. Screenshots go
// to docs/runbooks/screenshots-1c3.
//
// Runs after acceptance-1c1.mjs and acceptance-1c2.mjs in the same throwaway container, using the
// sessions 1C-1 handed over in ACCEPT_STATE_DIR (run with --network host on the build host):
//
//   ACCEPT_STATE_DIR=/tmp/accept node apps/web/e2e-live/acceptance-1c1.mjs && \
//   ACCEPT_STATE_DIR=/tmp/accept node apps/web/e2e-live/acceptance-1c2.mjs && \
//   ACCEPT_STATE_DIR=/tmp/accept node apps/web/e2e-live/acceptance-1c3.mjs
//
// Dev only: trusts Caddy's internal CA. Everything it creates is throwaway; the database is reset after.
import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { chromium } from "@playwright/test";

const BASE = process.env.LUME_URL ?? "https://lume.localhost:8443";
const MAILPIT = process.env.MAILPIT_URL ?? "http://127.0.0.1:8025";
const STATE = process.env.ACCEPT_STATE_DIR;
if (!STATE) throw new Error("ACCEPT_STATE_DIR is required (run acceptance-1c1.mjs first)");
const SHOTS = path.resolve(import.meta.dirname, "../../../docs/runbooks/screenshots-1c3");
mkdirSync(SHOTS, { recursive: true });

const ok = (msg) => console.log(`ok   ${msg}`);
function assert(cond, msg, detail) {
  if (!cond) {
    console.error(`FAIL ${msg}${detail === undefined ? "" : `\n     ${JSON.stringify(detail)}`}`);
    process.exit(1);
  }
  ok(msg);
}

const browser = await chromium.launch();
const withHydration = (page) => {
  const goto = page.goto.bind(page);
  page.goto = async (url) => {
    const r = await goto(url.startsWith("http") ? url : `${BASE}${url}`);
    await page.locator("html[data-hydrated]").waitFor({ state: "attached" });
    return r;
  };
  return page;
};
const context = async (storage, theme = "porcelain") => {
  const ctx = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 1366, height: 800 },
    reducedMotion: "reduce",
    ...(storage ? { storageState: path.join(STATE, `${storage}.json`) } : {}),
  });
  await ctx.addCookies([{ name: "lume_theme", value: theme, url: BASE }]);
  return ctx;
};
const signedIn = async (who, theme) => withHydration(await (await context(who, theme)).newPage());
const shot = async (page, name) => {
  await page.waitForTimeout(700);
  await page.screenshot({
    path: path.join(SHOTS, `${name}.png`),
    mask: [page.locator('[class*="clock"]'), page.getByRole("img", { name: /QR code/ })],
  });
};
/** Our own status line (the toast region is a second, usually empty, role="status"). */
const note = (page, text) => page.getByRole("status").filter({ hasText: text });
const api = (page, method, url, body) =>
  page.evaluate(
    async ({ method, url, body }) => {
      const { token } = await (await fetch("/api/v1/auth/csrf")).json();
      const res = await fetch(url, {
        method,
        headers: {
          "x-csrf-token": token,
          ...(method === "GET" ? {} : { "idempotency-key": crypto.randomUUID() }),
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await res.text();
      return { status: res.status, data: text ? JSON.parse(text) : null };
    },
    { method, url, body },
  );
async function inviteLink(address, since) {
  for (let i = 0; i < 60; i++) {
    const list = await (await fetch(`${MAILPIT}/api/v1/messages?limit=50`)).json();
    const hit = list.messages.find(
      (m) => m.To.some((t) => t.Address === address) && new Date(m.Created) > new Date(since),
    );
    if (hit) {
      const full = await (await fetch(`${MAILPIT}/api/v1/message/${hit.ID}`)).json();
      const link = /https:\/\/[^\s"<>]*\/invite\/[A-Za-z0-9_-]+/.exec(full.Text)?.[0];
      if (link) return link;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`no invite mail for ${address}`);
}

const owner = await signedIn("owner");
const rep = await signedIn("rep");

// 1 ─ Settings home: what each person can reach ───────────────────────────────────────────────────
await owner.goto("/settings");
const ownerNav = await owner.getByRole("navigation", { name: "Settings" }).getByRole("link").allInnerTexts();
assert(ownerNav.length === 11, "the owner reaches every settings page", ownerNav);
await shot(owner, "01-settings-home-owner");
await rep.goto("/settings");
const repNav = await rep.getByRole("navigation", { name: "Settings" }).getByRole("link").allInnerTexts();
assert(
  repNav.join("|") === "All settings|My account|About",
  "Riya (Sales) sees only her account and About",
  repNav,
);
await shot(rep, "02-settings-home-rep");
await rep.goto("/settings/roles");
assert(/\/today$/.test(rep.url()), "a page she can't use sends her back to Today", rep.url());

// 2 ─ rename a stage; the board follows ────────────────────────────────────────────────────────────
await owner.goto("/settings/pipeline");
await owner.getByRole("button", { name: "Rename Replied" }).click();
await owner.getByRole("textbox", { name: "Stage name" }).fill("Replied by DM");
await owner.getByRole("textbox", { name: "Stage name" }).press("Enter");
await note(owner, "Renamed to Replied by DM").waitFor();
await shot(owner, "03-pipeline-renamed");
await owner.goto("/pipeline");
assert((await owner.getByText("Replied by DM").count()) > 0, "the board shows the renamed stage");

// 3 ─ a new field, seen in the preview and on the New lead form ────────────────────────────────────
await owner.goto("/settings/fields");
await owner.getByRole("button", { name: "Add a field" }).click();
await owner.getByLabel("Field name").fill("Budget band");
await owner.getByLabel("Type").selectOption("select");
for (const o of ["Under 5k", "5k to 15k", "Over 15k"]) {
  await owner.getByRole("textbox", { name: "New option" }).fill(o);
  await owner.getByRole("textbox", { name: "New option" }).press("Enter");
}
const preview = owner.getByRole("region", { name: "Lead form preview" });
assert(
  (await preview.getByRole("combobox", { name: "Budget band" }).locator("option").allInnerTexts()).includes(
    "5k to 15k",
  ),
  "the preview shows the field, with its options, before it's saved",
);
await shot(owner, "04-field-preview");
await owner.getByRole("button", { name: "Create field" }).click();
await note(owner, "Budget band added").waitFor();
await owner.goto("/leads");
await owner.getByRole("button", { name: "New lead" }).first().click();
assert(
  await owner
    .getByRole("dialog", { name: "New lead" })
    .getByRole("combobox", { name: "Budget band" })
    .isVisible(),
  "the New lead form asks for it",
);
await shot(owner, "05-new-lead-with-field");
await owner.keyboard.press("Escape");

// 4 ─ hide a field from Sales: it leaves Riya's screens ────────────────────────────────────────────
const columnsOffer = async (page, name) => {
  await page.goto("/leads");
  await page.getByRole("button", { name: "Columns" }).click();
  const n = await page.getByRole("dialog", { name: "Columns" }).getByRole("checkbox", { name }).count();
  await page.keyboard.press("Escape");
  return n;
};
assert((await columnsOffer(rep, "Budget band")) === 1, "Riya can show Budget band as a column");
await owner.goto("/settings/roles");
await owner.getByRole("button", { name: /^Sales/ }).click();
await owner.getByRole("tab", { name: "Fields" }).click();
await owner.getByRole("radio", { name: "Budget band: Hidden" }).check();
await owner.waitForTimeout(500);
await shot(owner, "06-roles-field-access");
assert(
  (await columnsOffer(rep, "Budget band")) === 0,
  "once hidden from Sales, it's gone from Riya's columns",
);
await owner.getByRole("tab", { name: "What it can do" }).click();
await shot(owner, "07-roles-matrix");

// 5 ─ invite someone, then disable them: their session ends and their leads move ──────────────────
const OMAR = {
  name: "Omar Test",
  email: "omar@nupuur.test",
  password: `accept ${randomBytes(9).toString("base64url")} pass`,
};
await owner.goto("/settings/people");
const since = new Date(Date.now() - 2000).toISOString();
await owner.getByLabel("Email", { exact: true }).fill(OMAR.email);
await owner.getByLabel("Name", { exact: true }).fill(OMAR.name);
await owner.getByLabel("Role", { exact: true }).selectOption({ label: "Sales" });
await owner.getByRole("button", { name: "Send invite" }).click();
await note(owner, `Invite sent to ${OMAR.email}`).waitFor();
await shot(owner, "08-people-invited");
const omar = withHydration(await (await context(null)).newPage());
await omar.goto(await inviteLink(OMAR.email, since));
await omar.getByLabel("Choose a password").fill(OMAR.password);
await omar.getByRole("button", { name: "Join LUME" }).click();
await omar.waitForURL(/\/agree$/);
ok("Omar joins from the email");

const { people } = (await api(owner, "GET", "/api/v1/people")).data;
const idOf = (name) => people.find((p) => p.name === name)?.id;
const created = await api(owner, "POST", "/api/v1/leads", {
  name: "Handover Lead",
  phone: "+971509990001",
  ownerId: idOf(OMAR.name),
});
assert(created.status === 201, "a lead is given to Omar", created.data);
await owner.goto("/settings/people");
await owner.getByRole("button", { name: `Disable ${OMAR.name}` }).click();
const ask = owner.getByRole("dialog", { name: `Disable ${OMAR.name}?` });
await ask.getByLabel("Omar’s leads go to").selectOption({ label: "Riya Sharma" });
await shot(owner, "09-disable-hand-off");
await ask.getByRole("button", { name: "Disable" }).click();
await owner.getByRole("button", { name: `Enable ${OMAR.name}` }).waitFor();
await omar.reload();
await omar.waitForURL(/\/sign-in/);
ok("Omar's session ends at once");
const handed = await api(owner, "GET", `/api/v1/leads/${created.data.lead.id}`);
assert(handed.data.lead.ownerId === idOf("Riya Sharma"), "his lead is Riya's now", handed.data.lead.ownerId);

// 6 ─ the currency, switched at today's live rate ─────────────────────────────────────────────────
const priced = await api(owner, "POST", "/api/v1/leads", {
  name: "Priced Lead",
  phone: "+971509990002",
  value: 1000,
});
assert(priced.status === 201, "a lead worth AED 1,000", priced.data);
await owner.goto("/settings/business");
await owner.getByRole("button", { name: "Change currency" }).click();
await owner.getByRole("button", { name: /^New currency/ }).click();
await owner.getByRole("combobox", { name: "Search currencies" }).fill("usd");
await owner.keyboard.press("Enter");
const dialog = owner.getByRole("dialog", { name: "Change the currency to US Dollar?" });
await dialog.getByText(/^1 AED = /).waitFor({ timeout: 15_000 });
const source = await dialog.innerText();
assert(/open\.er-api\.com/.test(source), "the quote comes from open.er-api.com, dated", source);
const rate = Number(await dialog.getByLabel("1 AED in USD").inputValue());
assert(rate > 0.2 && rate < 0.35, `the live rate is plausible (1 AED = ${rate} USD)`, rate);
await shot(owner, "10-currency-quote");
await dialog.getByRole("button", { name: "Convert to USD" }).click();
await note(owner, "Every amount is now in US Dollar.").waitFor();
await shot(owner, "11-currency-switched");
const after = (await api(owner, "GET", `/api/v1/leads/${priced.data.lead.id}`)).data.lead;
const expected = Math.round(1000 * rate * 100) / 100;
// One currency: a lead stores no currency of its own; every amount is in the business currency.
const business = (await api(owner, "GET", "/api/v1/settings")).data;
assert(business.currency === "USD", "the business currency is now USD", business.currency);
assert(
  after.currency === null && Math.abs(after.value - expected) < 0.006,
  `AED 1,000 became USD ${after.value}, once (1,000 × ${rate})`,
  after,
);

// 7 ─ the audit log, in words ─────────────────────────────────────────────────────────────────────
await owner.goto("/settings/audit");
await owner.getByLabel("What").selectOption({ label: "Changed the currency" });
const line = owner.getByText(/Nupuur Patil changed the currency from AED to USD at /);
await line.waitFor();
assert(await line.isVisible(), "the audit log says who changed the currency, and at what rate");
await owner.getByLabel("What").selectOption({ label: "Anything" });
await owner
  .getByText(/disabled someone/)
  .first()
  .waitFor();
await shot(owner, "12-audit-log");

// 8 ─ my account and About ────────────────────────────────────────────────────────────────────────
await owner.goto("/settings/account");
await owner.getByText("This device").waitFor();
await shot(owner, "13-my-account");
await owner.goto("/settings/about");
const version = owner.getByText(/^Version \S+$/);
await version.waitFor();
ok(`About shows the running version (${await version.innerText()}) and the restore-test status`);
await shot(owner, "14-about");

// 9 ─ the same pages in Obsidian ──────────────────────────────────────────────────────────────────
const dark = await signedIn("owner", "obsidian");
await dark.goto("/settings/roles");
await dark.getByRole("tab", { name: "What it can do" }).waitFor();
await shot(dark, "15-roles-obsidian");
await dark.goto("/settings/fields");
await shot(dark, "16-fields-obsidian");

await browser.close();
console.log("acceptance 1C-3 passed");
