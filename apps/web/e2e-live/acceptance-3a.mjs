// Phase 3A live acceptance: follow-ups on the running dev stack, through Caddy's TLS, as the owner — report
// §17 Phase 3: "the reliability suite passes, including killing the worker mid-run". Run it in two halves
// around a restart of the API container (the chain script does the restart from the host):
//   node acceptance-3a.mjs set    — a follow-up due in 90 s, set from the drawer, seen on Today
//   (docker restart lumedev-api-1)
//   node acceptance-3a.mjs check  — its reminder still arrives, once; done → all clear
// Screenshots go to docs/runbooks/screenshots-3a. Needs ACCEPT_STATE_DIR from acceptance-1c1.mjs.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { chromium } from "@playwright/test";

const BASE = process.env.LUME_URL ?? "https://lume.localhost:8443";
const STATE = process.env.ACCEPT_STATE_DIR;
const MODE = process.argv[2];
if (!STATE) throw new Error("ACCEPT_STATE_DIR is required (run acceptance-1c1.mjs first)");
if (MODE !== "set" && MODE !== "check") throw new Error("usage: acceptance-3a.mjs set|check");
const SHOTS = path.resolve(import.meta.dirname, "../../../docs/runbooks/screenshots-3a");
const HANDOFF = path.join(STATE, "acceptance-3a.json");
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
const ctx = await browser.newContext({
  ignoreHTTPSErrors: true,
  viewport: { width: 1366, height: 800 },
  storageState: path.join(STATE, "owner.json"),
});
const page = await ctx.newPage();
const go = async (url) => {
  await page.goto(`${BASE}${url}`);
  await page.locator("html[data-hydrated]").waitFor({ state: "attached" });
};
const shot = async (name) => {
  await page.waitForTimeout(700);
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) }); // full content: nothing masked (owner, 2026-09-28)
};
const api = (method, url, body) =>
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

if (MODE === "set") {
  await go("/leads");
  const lead = (await api("POST", "/api/v1/leads", { name: "Acceptance Follow Up" })).data?.lead;
  assert(lead?.id, "a lead to follow up");
  await go(`/leads?lead=${lead.id}`);
  await page
    .getByRole("dialog", { name: "Acceptance Follow Up" })
    .getByRole("button", { name: "Follow-up", exact: true })
    .click();
  const sheet = page.getByRole("dialog", { name: "Follow up with Acceptance" });
  await sheet.getByText("In 1 hour", { exact: true }).click();
  await shot("01-follow-up-sheet");
  await sheet.getByRole("button", { name: "Set follow-up" }).click();
  await sheet.waitFor({ state: "hidden" });
  await page.getByRole("region", { name: "Next follow-up" }).waitFor();
  ok("set from the drawer, and shown as its next follow-up");
  const [task] = (await api("GET", `/api/v1/leads/${lead.id}/tasks`)).data.items;
  const due = new Date(Date.now() + 90_000).toISOString();
  assert(
    (await api("PATCH", `/api/v1/tasks/${task.id}`, { due: { at: due } })).status === 200,
    "moved to 90 s from now",
  );
  await go("/today");
  await page.getByRole("list", { name: "Due soon" }).getByText("Acceptance Follow Up").waitFor();
  ok("on Today, under Due soon");
  await shot("02-today");
  writeFileSync(HANDOFF, JSON.stringify({ lead: lead.id, task: task.id, due }));
  console.log("acceptance 3A (set) passed — now restart the API, then run: acceptance-3a.mjs check");
} else {
  const { lead, task, due } = JSON.parse(readFileSync(HANDOFF, "utf8"));
  await go("/leads");
  // Across the restart: the pg-boss job, or the sweeper at start-up, fires it — within 60 s of its time.
  const deadline = new Date(due).getTime() + 90_000;
  let found = [];
  while (Date.now() < deadline) {
    const { data } = await api("GET", "/api/v1/notifications");
    found = data.items.filter((n) => n.taskId === task && n.kind === "follow_up_due");
    if (found.length) break;
    await page.waitForTimeout(2000);
  }
  assert(found.length === 1, "the reminder arrived after the API restarted, exactly once", found);
  assert(
    !/\+?\d{7,}|@/.test(`${found[0].title} ${found[0].body}`),
    "it names the lead only, no contact details",
  );
  await page.getByRole("button", { name: "Notifications, new ones waiting" }).waitFor({ timeout: 10_000 });
  ok("the bell shows it");
  await go("/today");
  await page.getByRole("button", { name: "Done: Follow up — Acceptance Follow Up" }).click();
  await page.getByRole("heading", { name: "All clear" }).waitFor();
  ok("done on Today: all clear");
  await shot("03-all-clear");
  await api("POST", "/api/v1/leads/bulk", { ids: [lead], action: { type: "delete" } });
  console.log("acceptance 3A passed");
}
await browser.close();
