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
        matchedBy: "attendee",
        reminder: null,
      },
      {
        id: late,
        title: "Late call",
        startsAt: "2026-09-21T19:00:00.000Z",
        endsAt: "2026-09-21T19:30:00.000Z",
        link: "https://meet.example/x",
        status: "scheduled",
        lead: { id: lead, name: "Dana Lead" },
        matchedBy: "attendee",
        reminder: null,
      },
    ]);
  });

  it("5D: each call says where it came from and its WhatsApp reminder — still to go, or sent", async () => {
    const lead = await h.seedLead({ ownerId: me.id, name: "Reminded Lead" });
    const soon = await meeting(me.id, "2026-09-21T10:30:00Z", { lead, title: "Reminded call" }); // 2:30 pm
    const sent = await meeting(me.id, "2026-09-21T12:00:00Z", { lead, title: "Sent call" }); // 4 pm
    const c = await h.ownerPool.connect();
    try {
      await c.query("BEGIN");
      await c.query(
        "SELECT set_config('lume.user_id', $1, true), set_config('lume.lead_scope', 'all', true)",
        [me.id],
      );
      const task = (id: string, meetingId: string, dueAt: string, status: string, doneAt: string | null) =>
        c.query(
          `INSERT INTO tasks (id, lead_id, assignee_id, type, title, due_at, status, done_at, series_id, meeting_id)
           VALUES ($1, $2, $3, 'whatsapp', 'Remind', $4, $5, $6, $1, $7)`,
          [id, lead, me.id, dueAt, status, doneAt, meetingId],
        );
      await task(newId(), soon, "2026-09-21T08:30:00Z", "open", null);
      await task(newId(), sent, "2026-09-21T10:00:00Z", "done", "2026-09-21T08:45:00Z");
      await c.query("COMMIT");
    } finally {
      c.release();
    }
    const r = await mine.inject({ method: "GET", url: "/api/v1/today" });
    const byId = new Map(r.json().meetings.map((m: { id: string }) => [m.id, m]));
    expect(byId.get(soon)).toMatchObject({ reminder: { at: "2026-09-21T08:30:00.000Z", sent: false } });
    expect(byId.get(sent)).toMatchObject({ reminder: { at: "2026-09-21T08:45:00.000Z", sent: true } });
  });
});
