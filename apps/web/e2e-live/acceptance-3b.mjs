// Phase 3B live acceptance: the notification centre and the morning email on the running dev stack, through
// Caddy's TLS, as the owner, with the email read from Mailpit. Two halves around the API restart the 3A
// chain already does (a restart runs the digest at once, instead of on its quarter-hour tick):
//   node acceptance-3b.mjs set    — an overdue follow-up on a lead with a phone and an email; the owner asks
//                                    for the morning email every day from midnight; Settings screenshots
//   (the chain forgets today's digest for the owner, then restarts the API)
//   node acceptance-3b.mjs check  — the digest arrives in Mailpit with first names and times only; the
//                                    centre opens with "." and shows the overdue follow-up
// Screenshots go to docs/runbooks/screenshots-3b, full content (owner, 2026-09-28). Needs ACCEPT_STATE_DIR.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { chromium } from "@playwright/test";

const BASE = process.env.LUME_URL ?? "https://lume.localhost:8443";
const MAILPIT = process.env.MAILPIT_URL ?? "http://127.0.0.1:8025";
const STATE = process.env.ACCEPT_STATE_DIR;
const MODE = process.argv[2];
if (!STATE) throw new Error("ACCEPT_STATE_DIR is required (run acceptance-1c1.mjs first)");
if (MODE !== "set" && MODE !== "check") throw new Error("usage: acceptance-3b.mjs set|check");
const SHOTS = path.resolve(import.meta.dirname, "../../../docs/runbooks/screenshots-3b");
const HANDOFF = path.join(STATE, "acceptance-3b.json");
const OWNER_EMAIL = "maya@brightpath.test";
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
const shot = async (name, target = page) => {
  await page.waitForTimeout(700);
  await target.screenshot({ path: path.join(SHOTS, `${name}.png`) }); // full content: nothing masked
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
  const lead = (
    await api("POST", "/api/v1/leads", {
      name: "Morning Person",
      phone: "+971 50 765 4321",
      email: "morning.person@example.test",
    })
  ).data?.lead;
  assert(lead?.id, "a lead with a phone and an email");
  const due = new Date(Date.now() - 30 * 60_000).toISOString();
  const task = (
    await api("POST", `/api/v1/leads/${lead.id}/tasks`, { title: "Send the plan", due: { at: due } })
  ).data;
  assert(task?.id, "a follow-up, half an hour overdue");

  await go("/settings/follow-ups");
  await page.getByLabel("After how many hours").waitFor();
  await shot("01-settings-follow-ups");
  await go("/settings/account");
  const alerts = page.getByRole("region", { name: "Notifications" });
  await alerts.getByRole("switch", { name: "Morning email" }).waitFor();
  const r = await api("PATCH", "/api/v1/me", {
    preferences: { digestTime: "00:00", workingDays: [0, 1, 2, 3, 4, 5, 6] },
  });
  assert(r.status === 200, "the owner asks for the morning email every day, from midnight");
  await go("/settings/account");
  await alerts.scrollIntoViewIfNeeded();
  await shot("02-my-notifications", alerts);
  writeFileSync(HANDOFF, JSON.stringify({ lead: lead.id, since: new Date().toISOString() }));
  console.log(
    "acceptance 3B (set) passed — forget the owner's digest, restart the API, then: acceptance-3b.mjs check",
  );
} else {
  const { lead, since } = JSON.parse(readFileSync(HANDOFF, "utf8"));
  let hit = null;
  for (let i = 0; i < 60 && !hit; i++) {
    const list = await (await fetch(`${MAILPIT}/api/v1/messages?limit=50`)).json();
    hit = list.messages.find(
      (m) =>
        m.To.some((t) => t.Address === OWNER_EMAIL) &&
        new Date(m.Created) > new Date(since) &&
        /follow-up/.test(m.Subject),
    );
    if (!hit) await new Promise((r) => setTimeout(r, 2000));
  }
  assert(hit, "the morning email arrived in Mailpit after the restart");
  const full = await (await fetch(`${MAILPIT}/api/v1/message/${hit.ID}`)).json();
  assert(full.Text.includes("Good morning, Maya."), "it greets the owner by first name");
  assert(full.Text.includes("Morning: Send the plan"), "the overdue follow-up, by the lead's first name");
  assert(
    !/Morning Person|765 ?4321|morning\.person@/.test(`${full.Text}\n${full.HTML}`),
    "no full names, phones or emails in it",
  );
  // The email as it reads, rendered from its own HTML.
  const mail = await ctx.newPage();
  await mail.setContent(full.HTML);
  await mail.waitForTimeout(300);
  await mail.screenshot({ path: path.join(SHOTS, "03-morning-email.png"), fullPage: true });
  await mail.close();
  ok(`the email: "${hit.Subject}"`);

  await go("/leads");
  await page.keyboard.press(".");
  const centre = page.getByRole("dialog", { name: "Notifications" });
  await centre.getByRole("list", { name: "Overdue" }).getByText("Morning Person").waitFor();
  ok('"." opens the centre, with the overdue follow-up under Overdue');
  await shot("04-centre");
  await page.keyboard.press("f");
  await shot("05-centre-full");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await centre.waitFor({ state: "hidden" });
  ok("F goes full screen; Esc steps back, then closes");
  await api("POST", "/api/v1/leads/bulk", { ids: [lead], action: { type: "delete" } });
  console.log("acceptance 3B passed");
}
await browser.close();
