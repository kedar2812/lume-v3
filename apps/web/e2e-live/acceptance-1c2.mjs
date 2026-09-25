// Phase 1C-2 live acceptance: a real Chromium works leads on the running dev stack, through Caddy's TLS,
// as the owner, the admin and a masked sales rep. Screenshots go to docs/runbooks/screenshots-1c2.
//
// Runs straight after acceptance-1c1.mjs in the same throwaway container, using the sessions it handed
// over in ACCEPT_STATE_DIR (run with --network host on the build host):
//
//   ACCEPT_STATE_DIR=/tmp/accept node apps/web/e2e-live/acceptance-1c1.mjs && \
//   ACCEPT_STATE_DIR=/tmp/accept node apps/web/e2e-live/acceptance-1c2.mjs
//
// Dev only: trusts Caddy's internal CA. Everything it creates is throwaway; the database is reset after.
import { mkdirSync } from "node:fs";
import path from "node:path";
import { chromium } from "@playwright/test";

const BASE = process.env.LUME_URL ?? "https://lume.localhost:8443";
const STATE = process.env.ACCEPT_STATE_DIR;
if (!STATE) throw new Error("ACCEPT_STATE_DIR is required (run acceptance-1c1.mjs first)");
const SHOTS = path.resolve(import.meta.dirname, "../../../docs/runbooks/screenshots-1c2");
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
const signedIn = async (who, theme = "porcelain") => {
  const ctx = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 1366, height: 800 },
    reducedMotion: "reduce",
    storageState: path.join(STATE, `${who}.json`),
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
const shot = async (page, name) => {
  await page.waitForTimeout(700);
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), mask: [page.locator('[class*="clock"]')] });
};
/** The API from inside the page, with its cookies and a CSRF token, as the app calls it. */
const api = (page, method, url, body, headers = {}) =>
  page.evaluate(
    async ({ method, url, body, headers }) => {
      const { token } = await (await fetch("/api/v1/auth/csrf")).json();
      const res = await fetch(url, {
        method,
        headers: {
          "x-csrf-token": token,
          ...(method === "GET" ? {} : { "idempotency-key": crypto.randomUUID() }),
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await res.text();
      return { status: res.status, data: text ? JSON.parse(text) : null };
    },
    { method, url, body, headers },
  );

const owner = await signedIn("owner");
const rep = await signedIn("rep");
await owner.goto("/leads");

// 0 ─ the ground: a required field on Call booked, and a few leads ─────────────────────────────────
const { people } = (await api(owner, "GET", "/api/v1/people")).data;
const idOf = (name) => people.find((p) => p.name === name)?.id;
const RIYA = idOf("Riya Sharma");
const TASNEEM = idOf("Tasneem Shaikh");
assert(RIYA && TASNEEM, "Riya and Tasneem are on the team", people);
const { pipelines } = (await api(owner, "GET", "/api/v1/pipelines")).data;
const booked = pipelines[0].stages.find((s) => s.name === "Call booked");
const { fields } = (await api(owner, "GET", "/api/v1/fields")).data;
const struggles = fields.find((f) => f.key === "struggles");
const confidence = struggles.options.find((o) => o.label === "Confidence").id;
const required = await api(owner, "PATCH", `/api/v1/stages/${booked.id}`, {
  requiredFieldIds: [struggles.id],
});
assert(required.status === 200, "Call booked now needs Struggles", required.data);
const ids = {};
for (const l of [
  { name: "Omar Haddad", phone: "+971502223344", ownerId: RIYA },
  { name: "Sara Nasser", phone: "+971503334455", ownerId: RIYA, custom: { struggles: [confidence] } },
  { name: "Priya Menon", phone: "+971504445566", ownerId: RIYA },
  { name: "Karim Aziz", phone: "+971505556677", ownerId: TASNEEM, custom: { struggles: [confidence] } },
  { name: "Lina Farah", phone: "+971506667788", ownerId: null },
]) {
  const r = await api(owner, "POST", "/api/v1/leads", l);
  assert(r.status === 201, `${l.name} is added`, r.data);
  ids[l.name] = r.data.lead.id;
}

// 1 ─ create a lead in the sheet, then meet the duplicate warning ──────────────────────────────────
await owner.goto("/leads");
await owner.getByRole("button", { name: "New lead" }).first().click();
let sheet = owner.getByRole("dialog", { name: "New lead" });
await sheet.getByLabel("Name").fill("Aisha Khan");
await sheet.getByRole("button", { name: /^Country code/ }).click();
await owner.getByRole("combobox", { name: "Search countries" }).fill("united");
await shot(owner, "01a-country-picker");
await owner.getByRole("option", { name: "United Arab Emirates +971" }).click();
await sheet.getByLabel("Phone").fill("050 123 4567"); // typed as people say it; the code is added
assert(
  (await sheet.getByRole("button", { name: /^Country code/ }).getAttribute("aria-label")) ===
    "Country code: United Arab Emirates +971",
  "the phone's country is picked from a searchable list with flags",
);
await sheet.getByLabel("Email").fill("aisha@example.com");
await sheet.getByLabel("Owner").selectOption({ label: "Riya Sharma" });
await sheet.getByLabel("Deal value").fill("4500");
await shot(owner, "01b-new-lead-sheet");
await sheet.getByRole("button", { name: "Create lead" }).click();
await owner.getByRole("dialog", { name: "Aisha Khan" }).waitFor();
ids["Aisha Khan"] = new URL(owner.url()).searchParams.get("lead");
assert(!!ids["Aisha Khan"], "the new lead opens in the drawer, and the address names it", owner.url());
const saved = await api(owner, "GET", `/api/v1/leads/${ids["Aisha Khan"]}`);
assert(
  saved.data.lead.phone?.display === "+971 50 123 4567" && saved.data.lead.phone?.status === "valid",
  "the saved number carries the picked code, trunk zero dropped, valid for WhatsApp",
  saved.data.lead.phone,
);
await shot(owner, "01c-new-lead-opened");
await owner.keyboard.press("Escape");
await owner.getByRole("button", { name: "New lead" }).first().click();
sheet = owner.getByRole("dialog", { name: "New lead" });
await sheet.getByLabel("Name").fill("Aisha K");
await sheet.getByLabel("Phone").fill("+971 50 123 4567");
const status = sheet.getByRole("status");
await status.getByText(/already has this phone/).waitFor();
assert(
  (await status.innerText()).includes("Aisha Khan already has this phone · handled by Riya Sharma"),
  "typing a known number warns, naming the lead and who handles it",
  await status.innerText(),
);
await shot(owner, "01d-duplicate-warning");
await owner.keyboard.press("Escape");
await sheet.getByRole("button", { name: "Discard" }).click();
ok("closing a filled sheet asks first, then discards");

// 2 ─ move stages: the required-fields prompt, then the lost-reason prompt ─────────────────────────
await owner.goto("/leads?q=Omar");
await owner.getByRole("button", { name: "Open Omar Haddad" }).click();
const omar = owner.getByRole("dialog", { name: "Omar Haddad" });
await omar.getByRole("button", { name: /^Message sent/ }).click();
await omar.locator('[aria-current="step"]', { hasText: "Message sent" }).waitFor();
await omar.getByRole("button", { name: /^Call booked/ }).click();
const need = owner.getByRole("dialog", { name: /before moving to call booked/i });
await need.waitFor();
await shot(owner, "02a-required-fields");
await need.getByRole("checkbox", { name: "Confidence" }).check();
await need.getByRole("button", { name: "Save and move" }).click();
await omar.locator('[aria-current="step"]', { hasText: "Call booked" }).waitFor();
ok("Call booked asks for Struggles, saves it, then moves");
await omar.getByRole("button", { name: "Lost" }).click();
const why = owner.getByRole("dialog", { name: /why was omar lost/i });
await why.getByText("Not interested").click();
await shot(owner, "02b-lost-reason");
await why.getByRole("button", { name: "Mark as lost" }).click();
await omar.getByRole("tab", { name: "History" }).click();
await omar.getByText("Marked as lost").waitFor();
assert((await omar.getByText("Moved to Call booked").count()) === 1, "the history tells the story in words");
await shot(owner, "02c-history");

// 3 ─ the rep reveals a contact, and the owner sees it in the audit log ────────────────────────────
await rep.goto("/leads");
await rep.getByRole("button", { name: "Open Aisha Khan" }).click();
const aisha = rep.getByRole("dialog", { name: "Aisha Khan" });
await aisha.getByRole("button", { name: "Reveal contact" }).waitFor();
assert((await aisha.getByText("+971 50 123 4567").count()) === 0, "the rep sees Aisha's number masked");
await shot(rep, "03a-rep-masked");
await aisha.getByRole("button", { name: "Reveal contact" }).click();
await aisha.getByText("+971 50 123 4567").waitFor();
await aisha.getByText(/recorded in the audit log/i).waitFor();
await shot(rep, "03b-rep-revealed");
const audit = await api(
  owner,
  "GET",
  `/api/v1/audit?action=lead.contact.reveal&entityId=${ids["Aisha Khan"]}`,
);
assert(
  audit.status === 200 && audit.data.entries.some((e) => e.actorUserId === RIYA),
  "the owner finds Riya's reveal in the audit log",
  audit.data,
);

// 4 ─ reassign one of the rep's leads to the admin; the rep loses it at once ───────────────────────
await owner.goto("/leads?q=Priya");
await owner.getByRole("button", { name: "Open Priya Menon" }).click();
const priya = owner.getByRole("dialog", { name: "Priya Menon" });
await priya.getByRole("button", { name: /owner: riya sharma/i }).click();
await owner.getByRole("menuitem", { name: "Tasneem Shaikh" }).click();
await priya.getByRole("button", { name: /owner: tasneem shaikh/i }).waitFor();
await shot(owner, "04a-reassigned");
await rep.goto("/leads");
await rep.getByTestId("lead-row").first().waitFor();
assert(
  (await rep.getByRole("button", { name: "Open Priya Menon" }).count()) === 0,
  "Priya is gone from Riya's list",
);
await rep.goto(`/leads?lead=${ids["Priya Menon"]}`);
const gone = rep.getByText(/isn’t available to you/i);
await gone.waitFor();
const at = await gone.boundingBox();
assert(at && at.x >= 0 && at.x + at.width <= 1366, "a drawer opened from a link is on screen", at);
await shot(rep, "04b-rep-lost-access");
ok("Riya's old link to Priya explains itself instead of erroring");

// 5 ─ bulk: three selected, one skipped with the reason ────────────────────────────────────────────
await owner.goto("/leads");
for (const name of ["Sara Nasser", "Karim Aziz", "Lina Farah"])
  await owner.getByRole("checkbox", { name: `Select ${name}` }).check();
const bar = owner.getByRole("toolbar", { name: "Bulk actions" });
await bar.getByText("3 selected").waitFor();
await bar.getByRole("button", { name: "Move to stage" }).click();
await owner.getByRole("menuitem", { name: "Call booked" }).click();
await owner.getByText("2 moved, 1 skipped: missing required fields").waitFor();
await bar.getByText("1 selected").waitFor();
await shot(owner, "05-bulk-one-skipped");
ok("the skipped lead stays selected, ready to fix and retry");

// 6 ─ the masked role: no contact column, no export, names-only search (UI and API) ────────────────
await rep.goto("/leads");
const headers = (await rep.getByRole("columnheader").allInnerTexts()).join(" ");
assert(!/Phone|Email|Instagram/.test(headers), "a masked rep's table has no contact column", headers);
assert((await rep.getByRole("button", { name: /export/i }).count()) === 0, "and no export");
assert(
  (await rep.getByRole("searchbox").getAttribute("placeholder")) === "Search by name",
  "search says it's by name",
);
await rep.getByRole("searchbox").fill("501234567");
await rep
  .getByText("Nothing matches these filters")
  .waitFor()
  .catch(async (e) => {
    await rep.screenshot({ path: path.join(SHOTS, "FAILED-06.png") });
    throw e;
  });
await shot(rep, "06-rep-name-only-search");
const byName = await api(rep, "GET", "/api/v1/leads?q=Aisha");
const byDigits = await api(rep, "GET", "/api/v1/leads?q=501234567");
assert(
  byName.data.items[0]?.phone?.masked === true && byDigits.data.items.length === 0,
  "the API agrees: contacts arrive masked, and a number finds nothing",
  { byName: byName.data.items[0]?.phone, byDigits: byDigits.data.items.length },
);

// 6b ─ the stage strip: counts at a glance, one click to filter ─────────────────────────────────────
await owner.goto("/leads");
const strip = owner.getByRole("group", { name: "Stages" });
await strip.getByRole("button", { name: /^Call booked, 2 leads$/ }).click();
const filtered = await owner
  .waitForFunction(() => document.querySelectorAll('[data-testid="lead-row"]').length === 2, null, {
    timeout: 10_000,
  })
  .then(() => true)
  .catch(async () => {
    await owner.screenshot({ path: path.join(SHOTS, "FAILED-06b.png") });
    return false;
  });
assert(
  filtered && (await owner.getByRole("button", { name: "Open Sara Nasser" }).count()) === 1,
  "Call booked shows its two leads, as its count said",
);
await shot(owner, "06b-stage-strip");

// 7 ─ the board: a real pointer drag, and it sticks ────────────────────────────────────────────────
await owner.goto("/pipeline");
const col = (name) => owner.getByRole("region", { name: new RegExp(`^${name},`) });
const before = await col("Message sent").getAttribute("aria-label");
const card = col("New").locator("[data-lead-card]").filter({ hasText: "Aisha Khan" });
const a = await card.boundingBox();
const b = await col("Message sent").boundingBox();
await owner.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
await owner.mouse.down();
await owner.mouse.move(a.x + a.width / 2 + 20, a.y + a.height / 2, { steps: 4 });
await owner.mouse.move(b.x + b.width / 2, b.y + 120, { steps: 12 });
await owner.mouse.up();
await col("Message sent")
  .getByRole("button", { name: /Aisha Khan/ })
  .waitFor();
assert((await col("Message sent").getAttribute("aria-label")) !== before, "the count moves with the card");
await owner.goto("/pipeline");
await col("Message sent")
  .getByRole("button", { name: /Aisha Khan/ })
  .waitFor();
await shot(owner, "07-board");
ok("the drag sticks after a reload");

// 8 ─ the drawer in Obsidian ───────────────────────────────────────────────────────────────────────
const dark = await signedIn("owner", "obsidian");
await dark.goto(`/leads?lead=${ids["Karim Aziz"]}`);
await dark.getByRole("dialog", { name: "Karim Aziz" }).getByRole("heading", { name: "Karim Aziz" }).waitFor();
await shot(dark, "08-drawer-obsidian");

await browser.close();
console.log("acceptance 1C-2 passed");
