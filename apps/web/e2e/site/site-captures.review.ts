import { writeFileSync } from "node:fs";
import pg from "pg";
import type { Browser, Page } from "@playwright/test";
import { roleUrl } from "@lume/db";
import { LiveDayRefused, seedLiveDay } from "../../../api/src/demo/live-day";
import { DemoSeedRefused, seedDemoBusiness } from "../../../api/src/demo/seed";
import { callApi, openApp, PEOPLE, stateFile, test, type Who } from "../fixtures";
import { settle } from "../settle";
import { checkStory, rectsOf, toWebp, type StoryRule } from "./capture";

/**
 * The website's captures (website spec §6): the demo business doing well, a working day in progress, every screen
 * and action state the site shows, Porcelain and Obsidian, desktop at 2× and phone. Nothing is saved or sent:
 * popovers are captured open. On request only: LUME_REVIEW=1 playwright test --project site-captures. Output in
 * e2e/__site__/, handed to the website repo (public/screens/). Run it during the business day in Kolkata, so the
 * day has a morning behind it and an afternoon ahead.
 */
const OUT = "e2e/__site__";
type Shot = {
  name: string;
  as?: Who;
  path: string;
  phone?: boolean;
  then?: (page: Page) => Promise<void>;
  rects?: Record<string, string>;
};

const firstLead = async (page: Page) => {
  await page.getByRole("row").nth(1).click();
  await page.getByRole("dialog").first().waitFor();
};
const hidePhone = async (page: Page) => {
  await page.getByRole("button", { name: /Columns/ }).click();
  const phone = page.getByRole("checkbox", { name: "Phone" });
  if (await phone.isChecked()) await phone.click();
  await page.keyboard.press("Escape");
};
const tab = (name: string) => async (page: Page) => {
  await page
    .getByRole("tab", { name: new RegExp(`^${name}`) })
    .first()
    .click();
  await page.waitForLoadState("networkidle");
};
const TODAY_RECTS = {
  greeting: 'main header:has(h1:has-text("Good"))',
  day: 'section[aria-labelledby="your-day"]',
  work: 'section[aria-labelledby="up-next"]',
  leads: '[aria-label="How it\'s going"] > a:nth-of-type(1)',
  revenue: '[aria-label="How it\'s going"] > a:nth-of-type(2)',
  pipeline: '[aria-label="How it\'s going"] > a:nth-of-type(3)',
  calendar: '[aria-label="How it\'s going"] > a:nth-of-type(4)',
  team: '[aria-label="How it\'s going"] > a:nth-of-type(5)',
  replies: '[aria-label="How it\'s going"] > a:nth-of-type(6)',
};

const SHOTS: Shot[] = [
  { name: "today", path: "/today", rects: TODAY_RECTS },
  { name: "today-rep", as: "seller", path: "/today" },
  { name: "me", as: "seller", path: "/analytics" },
  { name: "team", path: "/analytics", then: tab("Team") },
  { name: "overview", path: "/analytics" },
  { name: "caught-no-touch", path: "/today", then: tab("Overdue") },
  {
    name: "caught-needs-you",
    path: "/today",
    then: async (p) => p.getByRole("button", { name: /^Needs you/ }).click(),
  },
  {
    name: "caught-source",
    path: "/analytics",
    then: async (p) => {
      await tab("Revenue & sources")(p);
      await settle(p);
      // The board re-renders once its numbers land: look again until the row holds still.
      for (let i = 0; i < 4; i++) {
        try {
          await p.getByText("Webinars").first().scrollIntoViewIfNeeded({ timeout: 5_000 });
          break;
        } catch {
          await p.waitForTimeout(800);
        }
      }
    },
  },
  {
    name: "caught-goal",
    path: "/analytics",
    then: async (p) =>
      p
        .getByText(/At this pace/)
        .first()
        .scrollIntoViewIfNeeded(),
  },
  { name: "leads", path: "/leads", then: hidePhone },
  {
    name: "action-whatsapp",
    path: "/leads",
    then: async (p) => {
      await firstLead(p);
      await p.keyboard.press("w");
    },
  },
  {
    name: "action-call",
    path: "/leads",
    then: async (p) => {
      await firstLead(p);
      await p.keyboard.press("c");
    },
  },
  {
    name: "action-follow-up",
    path: "/leads",
    then: async (p) => {
      await firstLead(p);
      await p.keyboard.press("f");
    },
  },
  {
    name: "action-won",
    path: "/leads",
    then: async (p) => {
      await firstLead(p);
      await p.getByRole("dialog").first().getByRole("button", { name: /^Won$/ }).click();
    },
  },
  {
    name: "action-bulk",
    path: "/leads",
    then: async (p) => {
      await hidePhone(p);
      await p.getByRole("checkbox", { name: "Select all loaded" }).click();
      await p
        .getByRole("button", { name: /Select all .* that match/ })
        .click()
        .catch(() => undefined);
      await p.getByRole("button", { name: /^Assign/ }).click();
      await p.getByRole("menuitemradio").first().click();
    },
  },
  {
    name: "action-queue",
    path: "/leads",
    then: async (p) => {
      await hidePhone(p);
      await p.getByRole("checkbox", { name: "Select all loaded" }).click();
      await p.getByRole("toolbar", { name: "Bulk actions" }).getByRole("button", { name: "Message" }).click();
      // Choose the first template when the panel offers one; the open panel is the moment either way.
      await p
        .getByRole("radiogroup", { name: "Message" })
        .getByRole("radio")
        .first()
        .click({ timeout: 5_000 })
        .catch(() => undefined);
    },
  },
  { name: "pipeline", path: "/pipeline" },
  {
    name: "action-search",
    path: "/leads",
    then: async (p) => {
      await hidePhone(p);
      await p.keyboard.press("Control+k");
      await p.keyboard.type("an");
    },
  },
  {
    name: "action-drill",
    path: "/analytics",
    then: async (p) => {
      await p.getByRole("button", { name: /^Won: .*See the leads/ }).click();
      await p.getByRole("dialog").first().waitFor();
    },
  },
  { name: "security", path: "/settings/security" },
  { name: "trace", path: "/settings/security/exports" },
  { name: "calendar", path: "/calendar" },
  { name: "today", path: "/today", phone: true, rects: TODAY_RECTS },
  { name: "leads", path: "/leads", phone: true },
  { name: "drawer", path: "/leads", phone: true, then: firstLead },
];

/** An API answer as JSON, or a clear error (the story checks read LUME's own numbers). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function api(p: Page, path: string): Promise<any> {
  const r = await callApi(p, "GET", path);
  if (r.status !== 200) throw new Error(`${path} → ${r.status} ${JSON.stringify(r.data).slice(0, 120)}`);
  return r.data;
}

/** What the screens must say before anything is shot (website spec §4.1). */
const STORY: StoryRule[] = [
  {
    what: "Today shows work in progress: overdue, due soon, done",
    check: async (p) => {
      const t = await api(p, "/api/v1/today");
      return t.overdue.length >= 2 && t.soon.length >= 1 && t.done >= 3 && t.meetings.length >= 2;
    },
  },
  {
    what: "Today's month is up on the same days of last month",
    check: async (p) => {
      const t = await api(p, "/api/v1/today/tiles");
      return t.month.value > t.month.previous;
    },
  },
  {
    what: "at least 8 of Analytics' numbers improved, revenue and wins among them",
    check: async (p) => {
      const o = await api(p, "/api/v1/analytics/overview?range=30d&compare=1");
      const tone = (id: string) => o.tiles.find((t: { id: string }) => t.id === id)?.trend?.tone;
      const good = o.tiles.filter((t: { trend?: { tone?: string } }) => t.trend?.tone === "good").length;
      return good >= 8 && tone("revenue_won") === "good" && tone("won") === "good";
    },
  },
  {
    what: "LUME noticed the planted catches (Webinars under-performing among them)",
    check: async (p) => {
      const ids: string[] = [];
      for (let i = 0; i < 4; i++)
        ids.push(
          ...(await api(p, "/api/v1/analytics/insights?range=90d")).insights.map((x: { id: string }) => x.id),
        );
      return ids.includes("source_under") && ids.includes("speed_pays");
    },
  },
];

async function seedOnce(now: Date) {
  const pool = new pg.Pool({ connectionString: roleUrl("lume_owner", "lume_e2e") });
  try {
    await pool.query(
      "UPDATE settings SET timezone = 'Asia/Kolkata', currency = 'INR', default_country_iso = 'IN' WHERE id = 1",
    );
    await pool.query("UPDATE users SET timezone = NULL WHERE email = ANY($1)", [
      [PEOPLE.owner.email, PEOPLE.seller.email],
    ]);
    try {
      await seedDemoBusiness(pool, { now, seed: 7, demoMode: true, trajectory: "growing" });
    } catch (e) {
      if (!(e instanceof DemoSeedRefused)) throw e;
    }
    const ids = await pool.query<{ id: string; email: string }>(
      "SELECT id, email FROM users WHERE email = ANY($1)",
      [[PEOPLE.owner.email, PEOPLE.seller.email]],
    );
    const id = (e: string) => ids.rows.find((r) => r.email === e)!.id;
    try {
      await seedLiveDay(pool, {
        now,
        people: [
          { userId: id(PEOPLE.owner.email), scope: "all" },
          { userId: id(PEOPLE.seller.email), scope: "own" },
        ],
      });
    } catch (e) {
      if (!(e instanceof LiveDayRefused)) throw e;
    }
  } finally {
    await pool.end();
  }
}

async function shoot(browser: Browser, shots: Shot[], who: Who, theme: "light" | "dark", phone: boolean) {
  const ctx = await browser.newContext({
    storageState: stateFile(who),
    colorScheme: theme,
    reducedMotion: "reduce",
    viewport: phone ? { width: 390, height: 844 } : { width: 1440, height: 900 },
    deviceScaleFactor: phone ? 3 : 2,
  });
  const page = await ctx.newPage();
  // Nothing waits for ever: a missing control fails its shot, named, and the rest go on.
  page.setDefaultTimeout(20_000);
  const made: {
    name: string;
    theme: string;
    phone: boolean;
    width: number;
    height: number;
    bytes: number;
  }[] = [];
  const failed: string[] = [];
  for (const shot of shots) {
    const file = `${shot.name}-${theme}${phone ? "-phone" : ""}`;
    try {
      await openApp(page, shot.path);
      await page.waitForLoadState("networkidle");
      if (shot.then) await shot.then(page);
      await page.waitForFunction(() => !document.querySelector('[aria-busy="true"]'), null, {
        timeout: 15_000,
      });
      await settle(page);
      const png = await page.screenshot({ animations: "disabled" });
      made.push({ name: shot.name, theme, phone, ...(await toWebp(png, `${OUT}/${file}.webp`)) });
      if (shot.rects)
        writeFileSync(`${OUT}/${file}.rects.json`, JSON.stringify(await rectsOf(page, shot.rects), null, 2));
    } catch (e) {
      failed.push(`${file}: ${(e as Error).message.split("\n")[0]}`);
    }
  }
  await ctx.close();
  return { made, failed };
}

test.describe("site captures", () => {
  test.setTimeout(3_600_000);

  test("every screen the website shows, both themes, desktop and phone", async ({ browser }) => {
    await seedOnce(new Date());
    const owner = await browser.newContext({ storageState: stateFile("owner") });
    const page = await owner.newPage();
    await openApp(page, "/today");
    const broken = await checkStory(page, STORY);
    await owner.close();
    if (broken.length) throw new Error(`The story isn't true yet:\n- ${broken.join("\n- ")}`);

    const made = [];
    const failed: string[] = [];
    for (const theme of ["light", "dark"] as const)
      for (const phone of [false, true])
        for (const who of ["owner", "seller"] as const) {
          const shots = SHOTS.filter((s) => !!s.phone === phone && (s.as ?? "owner") === who);
          if (!shots.length) continue;
          const r = await shoot(browser, shots, who, theme, phone);
          made.push(...r.made);
          failed.push(...r.failed);
        }
    writeFileSync(
      `${OUT}/manifest.json`,
      JSON.stringify({ capturedAt: new Date().toISOString(), screens: made }, null, 2),
    );
    if (failed.length) throw new Error(`Captures missing:\n- ${failed.join("\n- ")}`);
  });
});
