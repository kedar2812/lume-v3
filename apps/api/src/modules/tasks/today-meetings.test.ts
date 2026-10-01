import { ALL_GRANTS, newId } from "@lume/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type AuthedClient, type Harness, type SeededUser } from "../../../test/harness";

// The harness's clock: 2026-09-21T09:00Z, which is 1 pm in Dubai (the business's zone, and the caller's).
let h: Harness;
let me: SeededUser;
let other: SeededUser;
let mine: AuthedClient;

beforeAll(async () => {
  h = await createHarness({ preset: "coaching" });
  me = await h.seedUser({ grants: ALL_GRANTS, totp: true, name: "Maya Kapoor" });
  other = await h.seedUser({ grants: ALL_GRANTS, totp: true, name: "Omar Other" });
  mine = await h.signIn(me);
});
afterAll(() => h.close());

async function meeting(
  owner: string,
  startsAt: string,
  o: { lead?: string | null; status?: string; title?: string } = {},
) {
  const c = await h.ownerPool.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT set_config('lume.user_id', $1, true), set_config('lume.lead_scope', 'all', true)", [
      owner,
    ]);
    const id = newId();
    await c.query(
      `INSERT INTO meetings (id, lead_id, owner_id, source, external_id, title, starts_at, ends_at, matched_by, status, link)
       VALUES ($1, $2, $3, 'google', $4, $5, $6, $6::timestamptz + interval '30 minutes', 'attendee', $7, 'https://meet.example/x')`,
      [id, o.lead ?? null, owner, `ev-${id}`, o.title ?? "Call", startsAt, o.status ?? "scheduled"],
    );
    await c.query("COMMIT");
    return id;
  } finally {
    c.release();
  }
}

describe("Today's calls (5C Task 9)", () => {
  it("the caller's own meetings starting today on their clock, earliest first — not cancelled or moved, never anyone else's", async () => {
    const lead = await h.seedLead({ ownerId: me.id, name: "Dana Lead" });
    const late = await meeting(me.id, "2026-09-21T19:00:00Z", { lead, title: "Late call" }); // 11 pm in Dubai
    const morning = await meeting(me.id, "2026-09-21T05:00:00Z", { title: "Morning call" }); // 9 am
    await meeting(me.id, "2026-09-21T20:30:00Z"); // 00:30 tomorrow in Dubai
    await meeting(me.id, "2026-09-20T19:30:00Z"); // 11:30 pm yesterday
    await meeting(me.id, "2026-09-21T10:00:00Z", { status: "cancelled" });
    await meeting(me.id, "2026-09-21T11:00:00Z", { status: "rescheduled" });
    await meeting(other.id, "2026-09-21T12:00:00Z", { lead });
    const r = await mine.inject({ method: "GET", url: "/api/v1/today" });
    expect(r.statusCode).toBe(200);
    expect(r.json().meetings).toEqual([
      {
        id: morning,
        title: "Morning call",
        startsAt: "2026-09-21T05:00:00.000Z",
        endsAt: "2026-09-21T05:30:00.000Z",
        link: "https://meet.example/x",
        status: "scheduled",
        lead: null,
      },
      {
        id: late,
        title: "Late call",
        startsAt: "2026-09-21T19:00:00.000Z",
        endsAt: "2026-09-21T19:30:00.000Z",
        link: "https://meet.example/x",
        status: "scheduled",
        lead: { id: lead, name: "Dana Lead" },
      },
    ]);
  });
});
