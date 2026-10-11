import pg from "pg";
import type { Page } from "@playwright/test";
import { roleUrl } from "@lume/db";
import { LiveDayRefused, seedLiveDay } from "../../../api/src/demo/live-day";
import { DemoSeedRefused, seedDemoBusiness } from "../../../api/src/demo/seed";
import { callApi, PEOPLE } from "../fixtures";
import type { StoryRule } from "./capture";
import type { Who } from "../fixtures";

/**
 * What the website's captures and the product tour's share: the demo business seeded in (growing, a live day in
 * progress), the story it must tell before anything is shot, and the clicks that open each screen's moment.
 */

export type Shot = {
  name: string;
  as?: Who;
  path: string;
  phone?: boolean;
  then?: (page: Page) => Promise<void>;
  rects?: Record<string, string>;
};

/** The list narrowed to leads going well — replied, call booked, won — so the site never opens on a lost one. */
export const goodStages = async (page: Page, stages = ["Replied", "Call booked", "Won"]) => {
  const strip = page.getByRole("group", { name: "Stages" });
  let first = true;
  for (const name of stages) {
    const b = strip.getByRole("button", { name: new RegExp(`^${name}`) }).first();
    if (!(await b.isVisible().catch(() => false))) continue;
    await b.click({ modifiers: first ? [] : ["Control"] });
    first = false;
  }
  await page.waitForLoadState("networkidle");
};
export const firstLead = async (page: Page, stages?: string[]) => {
  await goodStages(page, stages);
  await page.getByRole("row").nth(1).click();
  await page.getByRole("dialog").first().waitFor();
};
export const hidePhone = async (page: Page) => {
  await page.getByRole("button", { name: /Columns/ }).click();
  const phone = page.getByRole("checkbox", { name: "Phone" });
  if (await phone.isChecked()) await phone.click();
  await page.keyboard.press("Escape");
};
export const tab = (name: string) => async (page: Page) => {
  await page
    .getByRole("tab", { name: new RegExp(`^${name}`) })
    .first()
    .click();
  await page.waitForLoadState("networkidle");
};
/** An API answer as JSON, or a clear error (the story checks read LUME's own numbers). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function api(p: Page, path: string): Promise<any> {
  const r = await callApi(p, "GET", path);
  if (r.status !== 200) throw new Error(`${path} → ${r.status} ${JSON.stringify(r.data).slice(0, 120)}`);
  return r.data;
}

/** What the screens must say before anything is shot (website spec §4.1). */
export const STORY: StoryRule[] = [
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

export async function seedOnce(now: Date) {
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

/**
 * LUME holds back a note a person has seen in the last 14 days. The story check and every Analytics shot read the
 * notes, so each shot forgets that first: the screens show them as a first look would.
 */
export async function forgetSeen() {
  const pool = new pg.Pool({ connectionString: roleUrl("lume_owner", "lume_e2e") });
  try {
    await pool.query("DELETE FROM analytics_insight_seen");
  } finally {
    await pool.end();
  }
}
