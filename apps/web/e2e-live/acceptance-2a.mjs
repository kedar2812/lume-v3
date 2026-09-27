// Phase 2A live acceptance: CSV import on the running dev stack, through Caddy's TLS, as the owner — the
// spec's §11 test: a 500-row messy sheet imports with zero duplicates and correct phone statuses, and a
// re-import or a shuffled copy creates nothing. Screenshots go to docs/runbooks/screenshots-2a.
//
// Runs after acceptance-1c1.mjs (and 1c2, 1c3) in the same throwaway container, with the sessions 1C-1
// handed over in ACCEPT_STATE_DIR. Dev only: trusts Caddy's internal CA; the database is reset after.
import { mkdirSync } from "node:fs";
import path from "node:path";
import { chromium } from "@playwright/test";

const BASE = process.env.LUME_URL ?? "https://lume.localhost:8443";
const STATE = process.env.ACCEPT_STATE_DIR;
if (!STATE) throw new Error("ACCEPT_STATE_DIR is required (run acceptance-1c1.mjs first)");
const SHOTS = path.resolve(import.meta.dirname, "../../../docs/runbooks/screenshots-2a");
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
      return {
        status: res.status,
        data: text ? JSON.parse(text) : null,
        headers: Object.fromEntries(res.headers),
      };
    },
    { method, url, body },
  );
/** An import through the API, run to the end (for checks that only need its result). */
async function importViaApi(page, name, text, rules = {}) {
  const draft = await page.evaluate(
    async ({ name, text }) => {
      const { token } = await (await fetch("/api/v1/auth/csrf")).json();
      const res = await fetch("/api/v1/imports", {
        method: "POST",
        headers: { "x-csrf-token": token, "content-type": "application/octet-stream", "x-file-name": name },
        body: text,
      });
      return res.json();
    },
    { name, text },
  );
  if (Object.keys(rules).length)
    await api(page, "PATCH", `/api/v1/imports/${draft.id}`, { rules: { ...draft.rules, ...rules } });
  const started = await api(page, "POST", `/api/v1/imports/${draft.id}/start`);
  assert(started.status === 200, `${name}: Start is accepted`, started.data);
  for (let i = 0; i < 240; i++) {
    const v = (await api(page, "GET", `/api/v1/imports/${draft.id}`)).data;
    if (!["queued", "running", "cancelling"].includes(v.status)) {
      await api(page, "POST", `/api/v1/imports/${draft.id}/seen`);
      return v;
    }
    await page.waitForTimeout(500);
  }
  throw new Error(`${name} never finished`);
}
async function leadsFrom(page, sourceId, extra = "") {
  const all = [];
  let cursor = null;
  do {
    const r = await api(
      page,
      "GET",
      `/api/v1/leads?source=${sourceId}&limit=100${extra}${cursor ? `&cursor=${cursor}` : ""}`,
    );
    all.push(...r.data.items);
    cursor = r.data.nextCursor;
  } while (cursor);
  return all;
}

// The §11 file: 400 people, then 100 repeats of them by email in another case; phones local, spaced
// international, 00-prefixed and plain international, a few blank and a few shortened by Excel.
const rows = [];
const want = { valid: 0, invalid: 0, missing: 0 };
for (let i = 0; i < 400; i++) {
  const national = `50${String(1000000 + i * 7).slice(-7)}`;
  const forms = [
    `0${national}`,
    `+971 ${national.slice(0, 2)} ${national.slice(2, 5)} ${national.slice(5)}`,
    `00971${national}`,
    `+971${national}`,
  ];
  const phone = i % 50 === 0 ? "" : i % 97 === 0 ? "9.71501E+11" : forms[i % forms.length];
  rows.push(`Messy Person ${i},${phone},messy${i}@example.test`);
  if (i % 50 === 0) want.missing++;
  else if (i % 97 === 0) want.invalid++;
  else want.valid++;
}
for (let i = 0; i < 100; i++) rows.push(`Messy Person ${i} again,,MESSY${i}@EXAMPLE.test`);
const FILE = `Name,Phone,Email\n${rows.join("\n")}\n`;
const shuffled = `Name,Phone,Email\n${rows
  .map((l, i) => ({ l, k: (i * 7919) % rows.length }))
  .sort((a, b) => a.k - b.k)
  .map((x) => x.l)
  .join("\n")}\n`;

// 1 ─ the sheet, step by step, as the owner ──────────────────────────────────────────────────────
const owner = await signedIn("owner");
await owner.goto("/leads");
await owner.getByRole("button", { name: "Import", exact: true }).click();
const sheet = owner.getByRole("dialog", { name: "Import leads" });
await sheet
  .getByLabel("Choose a CSV file")
  .setInputFiles({ name: "messy-500.csv", mimeType: "text/csv", buffer: Buffer.from(FILE) });
await sheet.getByText("messy-500.csv · 500 rows").waitFor();
ok("the file is read: 500 rows, UTF-8, comma-separated, header on row 1");
await shot(owner, "01-file");
await sheet.getByRole("button", { name: "Continue" }).click();
for (const [h, v] of [
  ["Name", "name"],
  ["Phone", "phone"],
  ["Email", "email"],
])
  assert(
    (await sheet.getByRole("combobox", { name: `${h} goes to` }).inputValue()) === v,
    `Columns: ${h} goes to ${v}`,
  );
await shot(owner, "02-columns");
await sheet.getByRole("button", { name: "Continue" }).click();
await sheet.getByRole("heading", { name: "How to add them" }).waitFor();
await shot(owner, "03-rules");
await sheet.getByRole("button", { name: "Continue" }).click();
await sheet.getByText(/^\d+ create/).waitFor();
ok(`Preview: ${await sheet.getByText(/^\d+ create/).textContent()}`);
await shot(owner, "04-preview");
await sheet.getByRole("button", { name: "Import 500 rows" }).click();
await sheet
  .getByRole("progressbar", { name: "Rows done" })
  .or(sheet.getByRole("heading", { name: /is in LUME/ }))
  .first()
  .waitFor();
await shot(owner, "05-running");
await sheet.getByRole("heading", { name: "messy-500.csv is in LUME" }).waitFor({ timeout: 180_000 });
await shot(owner, "06-report");

// 2 ─ what it did, checked through the API ─────────────────────────────────────────────────────
const first = (await api(owner, "GET", "/api/v1/imports")).data.imports.find(
  (i) => i.fileName === "messy-500.csv",
);
assert(
  first.counts.created === 400 && first.counts.merged === 100 && first.counts.errors === 0,
  "500 rows: 400 created, 100 merged into them, no problems",
  first.counts,
);
const made = await leadsFrom(owner, first.sourceId);
assert(made.length === 400, "exactly 400 leads came from the file", made.length);
const emails = new Set(made.map((l) => l.email?.display));
assert(emails.size === 400, "zero duplicates: every email belongs to exactly one lead", emails.size);
for (const [status, n] of Object.entries(want)) {
  const got = (await leadsFrom(owner, first.sourceId, `&phoneStatus=${status}`)).length;
  assert(got === n, `phone statuses: ${n} ${status}`, got);
}

const again = await importViaApi(owner, "messy-500.csv", FILE);
assert(
  again.counts.created === 0 && again.counts.merged === 500,
  "the same file again creates nothing and merges all 500",
  again.counts,
);
const mixed = await importViaApi(owner, "messy-500-shuffled.csv", shuffled);
assert(mixed.counts.created === 0, "a shuffled copy creates nothing", mixed.counts);

// 3 ─ the failed rows, as a download that opens safely in Excel ──────────────────────────────────
const bad = await importViaApi(
  owner,
  "with-problems.csv",
  'Name,Stage,Note\nFine Row,New,ok\nBad Row,Nowhere,=HYPERLINK("x")\n',
);
assert(
  bad.counts.errors === 1 && bad.counts.created === 1,
  "a file with one bad row: 1 created, 1 with problems",
  bad.counts,
);
const csv = await owner.evaluate(async (id) => {
  const r = await fetch(`/api/v1/imports/${id}/errors.csv`);
  // Raw bytes: text() drops a leading BOM, which is exactly what's being checked.
  const bytes = new Uint8Array(await r.arrayBuffer());
  return {
    type: r.headers.get("content-type"),
    bom: bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf,
    body: new TextDecoder().decode(bytes),
  };
}, bad.id);
assert(csv.type.startsWith("text/csv"), "the failed rows download as CSV", csv.type);
assert(
  csv.bom && csv.body.startsWith("Problem,Name,Stage,Note"),
  "with a BOM and the file's own headers",
  csv.body.slice(0, 40),
);
assert(
  csv.body.includes("'=HYPERLINK") && !csv.body.includes("Fine Row"),
  "only the failed row, formulas defused",
  csv.body,
);

// 4 ─ the bulk phone fix ──────────────────────────────────────────────────────────────────────────
const local = await importViaApi(
  owner,
  "needs-code.csv",
  "Name,Phone\nLocal One,0507300001\nLocal Two,0507300002\nLocal Three,0507300003\n",
  {
    defaultCountry: null,
  },
);
assert(local.counts.phoneNeedsCountry === 3, "three numbers without a country are counted", local.counts);
await owner.goto("/leads?phone=needs_country");
await owner.getByTestId("lead-row").first().waitFor();
await owner.getByRole("checkbox", { name: "Select all loaded" }).check();
await owner.getByRole("button", { name: "Set country…" }).click();
await shot(owner, "07-bulk-phone-fix");
await owner.getByRole("button", { name: "Set country", exact: true }).click();
await owner.getByText("3 fixed").waitFor();
const fixed = await leadsFrom(owner, local.sourceId, "&phoneStatus=valid");
assert(fixed.length === 3, "the bulk fix gives all three their country", fixed.length);

// 5 ─ Settings → Imports, in both themes ─────────────────────────────────────────────────────────
await owner.goto("/settings/imports");
await owner.getByRole("region", { name: "Past imports" }).waitFor();
// The list arrives after the page: wait for it rather than asking once.
await owner
  .getByRole("heading", { name: "messy-500.csv" })
  .first()
  .waitFor({ timeout: 10_000 })
  .catch(() => undefined);
assert(
  await owner.getByRole("heading", { name: "messy-500.csv" }).first().isVisible(),
  "Settings → Imports lists the import",
);
await shot(owner, "08-settings-imports");
const dark = await signedIn("owner", "obsidian");
await dark.goto("/settings/imports");
await dark.getByRole("button", { name: "Open the report for messy-500-shuffled.csv" }).click();
await dark.getByRole("heading", { name: "messy-500-shuffled.csv is in LUME" }).waitFor();
await shot(dark, "09-report-obsidian");

// 6 ─ someone without Import leads sees no Import ────────────────────────────────────────────────
const rep = await signedIn("rep");
await rep.goto("/leads");
assert(
  (await rep.getByRole("button", { name: /^Import/ }).count()) === 0,
  "a sales rep sees no Import button",
);

await browser.close();
console.log("acceptance 2A passed");
