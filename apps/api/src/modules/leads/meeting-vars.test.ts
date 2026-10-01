import { ALL_GRANTS, newId } from "@lume/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type AuthedClient, type Harness, type SeededUser } from "../../../test/harness";

let h: Harness;
let me: SeededUser;
let admin: AuthedClient;

beforeAll(async () => {
  h = await createHarness({ preset: "coaching" }); // the business's zone is Asia/Dubai
  me = await h.seedUser({ grants: ALL_GRANTS, totp: true });
  admin = await h.signIn(me);
});
afterAll(() => h.close());

const HOUR = 3_600_000;
async function meeting(
  lead: string,
  startsInHours: number,
  o: { status?: string; link?: string | null } = {},
) {
  const c = await h.ownerPool.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT set_config('lume.user_id', $1, true), set_config('lume.lead_scope', 'all', true)", [
      me.id,
    ]);
    const starts = new Date(Date.now() + startsInHours * HOUR);
    await c.query(
      `INSERT INTO meetings (id, lead_id, owner_id, source, external_id, title, starts_at, ends_at, matched_by, status, link)
       VALUES ($1, $2, $3, 'google', $4, 'Call', $5, $6, 'attendee', $7, $8)`,
      [
        newId(),
        lead,
        me.id,
        `ev-${newId()}`,
        starts,
        new Date(starts.getTime() + HOUR / 2),
        o.status ?? "scheduled",
        o.link ?? null,
      ],
    );
    await c.query("COMMIT");
    return starts;
  } finally {
    c.release();
  }
}
const rendered = (lead: string, text: string) =>
  admin
    .inject({ method: "POST", url: `/api/v1/leads/${lead}/messages/render`, payload: { text } })
    .then((r) => r.json());

describe("meeting variables in messages (5C Task 7)", () => {
  it("the lead's next scheduled meeting: not one that's past, or cancelled", async () => {
    const lead = await h.seedLead({ ownerId: me.id, name: "Meeting Lead" });
    await meeting(lead, -3, { link: "https://meet.example/past" });
    await meeting(lead, 5, { status: "cancelled", link: "https://meet.example/cancelled" });
    const next = await meeting(lead, 30, { link: "https://meet.example/next" });
    await meeting(lead, 60, { link: "https://meet.example/later" });
    const r = await rendered(lead, "{{meeting.date}} {{meeting.time}} {{meeting.link}}");
    const day = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Dubai",
      weekday: "long",
      day: "numeric",
      month: "long",
    })
      .formatToParts(next)
      .reduce((a, p) => ({ ...a, [p.type]: p.value }), {} as Record<string, string>);
    expect(r.missing).toEqual([]);
    expect(r.text).toContain(`${day.month} ${day.day}, ${day.weekday}`);
    expect(r.text).toMatch(/ \d{1,2}(:\d\d)? (am|pm) https:\/\/meet\.example\/next$/);
  });

  it("with no meeting to come, the variables are missing", async () => {
    const lead = await h.seedLead({ ownerId: me.id, name: "No Meeting Lead" });
    await meeting(lead, -10);
    expect((await rendered(lead, "{{meeting.date}}")).missing).toEqual(["meeting.date"]);
  });
});
