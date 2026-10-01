import pg from "pg";
import { ALL_GRANTS, newId } from "@lume/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startCalendlyFake, type CalendlyFake } from "../../../test/calendly-fake";
import { createHarness, type AuthedClient, type Harness, type SeededUser } from "../../../test/harness";

let h: Harness;
let fake: CalendlyFake;
let admin: SeededUser;
let adminC: AuthedClient;
let host: SeededUser;
let rep: SeededUser;
let stages: Record<string, string>;
let pipelineId: string;
let sourceId: string;

beforeAll(async () => {
  fake = await startCalendlyFake();
  h = await createHarness({ preset: "coaching", calendlyEndpoint: fake.url });
  admin = await h.seedUser({ grants: ALL_GRANTS, totp: true, name: "Ada Admin" });
  adminC = await h.signIn(admin);
  host = await h.seedUser({ grants: ALL_GRANTS, totp: true, name: "Hana Host" });
  rep = await h.seedUser({ grants: [{ key: "leads.view", scope: "own" }], name: "Rory Rep" });
  const cfg = await h.config();
  stages = cfg.stages;
  pipelineId = cfg.pipelineId;
  expect(
    (
      await adminC.inject({
        method: "POST",
        url: "/api/v1/integrations/calendly",
        payload: { token: fake.token },
      })
    ).statusCode,
  ).toBe(200);
  sourceId = (await h.ownerPool.query<{ id: string }>("SELECT id FROM lead_sources WHERE type = 'calendly'"))
    .rows[0]!.id;
  const r = await adminC.inject({
    method: "PATCH",
    url: `/api/v1/pipelines/${pipelineId}`,
    payload: { bookingStageId: stages["Call booked"] },
  });
  expect(r.statusCode).toBe(200);
  // The booking stage's own automation: a follow-up to prepare.
  await h.ownerPool.query("UPDATE stages SET on_enter = $1 WHERE id = $2", [
    {
      rules: [
        {
          id: newId(),
          type: "create_task",
          title: "Prepare for the call",
          dueIn: { n: 1, unit: "day" },
          assignee: "lead_owner",
        },
      ],
    },
    stages["Call booked"],
  ]);
});
afterAll(async () => {
  await h.close();
  await fake.close();
});

type Booking = {
  invitee: string;
  event?: "invitee.created" | "invitee.canceled";
  email?: string;
  name?: string;
  phone?: string | null;
  host?: string;
  title?: string;
  qa?: { question: string; answer: string }[];
  rescheduled?: boolean;
  reason?: string;
  /** When it starts (ISO); a fixed day unless a test needs one still to come. */
  start?: string;
};
const START = "2026-09-24T10:00:00.000000Z";
const body = (b: Booking) => {
  const event = b.event ?? "invitee.created";
  return {
    event,
    created_at: "2026-09-21T09:00:00.000000Z",
    payload: {
      email: b.email ?? `${b.invitee.toLowerCase()}@client.test`,
      name: b.name ?? `Invitee ${b.invitee}`,
      first_name: null,
      last_name: null,
      text_reminder_number: b.phone ?? null,
      questions_and_answers: b.qa ?? [],
      timezone: "Asia/Dubai",
      uri: `https://api.calendly.com/scheduled_events/EV-${b.invitee}/invitees/${b.invitee}`,
      status: event === "invitee.created" ? "active" : "canceled",
      rescheduled: b.rescheduled ?? false,
      ...(event === "invitee.canceled"
        ? { cancellation: { canceled_by: "Invitee", reason: b.reason ?? null, canceler_type: "invitee" } }
        : {}),
      scheduled_event: {
        uri: `https://api.calendly.com/scheduled_events/EV-${b.invitee}`,
        name: b.title ?? "Discovery call",
        status: event === "invitee.created" ? "active" : "canceled",
        start_time: b.start ?? START,
        end_time: new Date(new Date(b.start ?? START).getTime() + 30 * 60_000).toISOString(),
        location: { type: "google_conference", join_url: "https://meet.example/abc" },
        event_memberships: [
          { user: "https://api.calendly.com/users/H", user_email: b.host ?? host.email, user_name: "Host" },
        ],
      },
    },
  };
};
/** Calendly delivers (signed with the subscription's key, at the test's clock), and the queue runs it. */
async function deliver(b: Booking) {
  const sub = fake.subscriptions[0]!;
  const { headers, payload } = fake.signed(
    sub,
    body(b),
    h.clock.now.getTime() + Math.floor(Math.random() * 1000),
  );
  const r = await h.app.inject({ method: "POST", url: new URL(sub.callbackUrl).pathname, headers, payload });
  expect(r.statusCode).toBe(202);
  await h.runWebhooks();
}
async function backup<R>(sql: string, params: unknown[] = []): Promise<R[]> {
  const c = new pg.Client({ connectionString: h.url("lume_readonly_backup") });
  await c.connect();
  try {
    return (await c.query(sql, params)).rows as R[];
  } finally {
    await c.end();
  }
}
const meetingOf = async (invitee: string) =>
  (
    await backup<{
      id: string;
      lead_id: string | null;
      owner_id: string;
      status: string;
      title: string;
      link: string | null;
      matched_by: string;
      source: string;
    }>(
      "SELECT id, lead_id, owner_id, status, title, link, matched_by, source FROM meetings WHERE external_id LIKE $1",
      [`%/invitees/${invitee}`],
    )
  )[0];
const leadsBy = (email: string) =>
  h.queryAll<{ id: string; stage_id: string; owner_id: string | null; name: string }>(
    "SELECT id, stage_id, owner_id, name FROM leads WHERE email = $1 AND deleted_at IS NULL",
    [email],
  );
const activities = (leadId: string, type: string) =>
  h.queryAll<{ payload: Record<string, unknown> }>(
    "SELECT payload FROM activities WHERE lead_id = $1 AND type = $2",
    [leadId, type],
  );
const told = (kind: string) =>
  backup<{ user_id: string; title: string }>(
    "SELECT user_id, title FROM notifications WHERE kind = $1 ORDER BY id",
    [kind],
  );
const eventOf = async (invitee: string, event = "invitee.created") =>
  (
    await h.ownerPool.query<{ status: string; problems: { code: string }[] }>(
      "SELECT status, problems FROM webhook_events WHERE source_id = $1 AND event_key LIKE $2",
      [sourceId, `${event}:%/invitees/${invitee}`],
    )
  ).rows[0];

describe("a booking (5B Task 6)", () => {
  it("someone new: a lead, moved to the booking stage (its automations run), a meeting, history, its owner told — in under 30 s", async () => {
    const t0 = Date.now();
    await deliver({ invitee: "NEW1", email: "dana@client.test", name: "Dana Lead", phone: "+971501234567" });
    expect(Date.now() - t0).toBeLessThan(30_000);
    const [lead] = await leadsBy("dana@client.test");
    expect(lead).toMatchObject({ name: "Dana Lead", stage_id: stages["Call booked"], owner_id: host.id });
    expect(await meetingOf("NEW1")).toMatchObject({
      lead_id: lead!.id,
      owner_id: host.id,
      status: "scheduled",
      title: "Discovery call",
      link: "https://meet.example/abc",
      matched_by: "calendly",
      source: "calendly",
    });
    expect(await activities(lead!.id, "meeting_booked")).toHaveLength(1);
    expect(
      await h.queryAll("SELECT id FROM tasks WHERE lead_id = $1 AND title = 'Prepare for the call'", [
        lead!.id,
      ]),
    ).toHaveLength(1);
    expect((await told("meeting_booked")).filter((n) => n.user_id === host.id).map((n) => n.title)).toEqual([
      "Dana Lead booked Discovery call",
    ]);
    expect(await eventOf("NEW1")).toMatchObject({ status: "done" });
  });

  it("someone already a lead (same email in any case, or the phone from the mapped question) is that lead, never a second", async () => {
    const byEmail = await h.seedLead({ ownerId: rep.id, name: "Repeat Lead", email: "Repeat@Client.test" });
    await deliver({ invitee: "REP1", email: "repeat@client.test", name: "Repeat Lead" });
    expect((await leadsBy("repeat@client.test")).map((l) => l.id)).toEqual([byEmail]);
    expect((await meetingOf("REP1"))!.lead_id).toBe(byEmail);

    const byPhone = await h.seedLead({ ownerId: rep.id, name: "Phone Lead", phone: "+971509998877" });
    expect(
      (
        await adminC.inject({
          method: "PATCH",
          url: "/api/v1/integrations/calendly",
          payload: { phoneQuestion: "Your WhatsApp number" },
        })
      ).statusCode,
    ).toBe(200);
    await deliver({
      invitee: "PHONE1",
      email: "phone.new@client.test",
      name: "Phone Lead",
      qa: [{ question: "your whatsapp number ", answer: "050 999 8877" }],
    });
    expect((await meetingOf("PHONE1"))!.lead_id).toBe(byPhone);
    // merged into that lead (its new email filled in), not a second lead
    expect((await leadsBy("phone.new@client.test")).map((l) => l.id)).toEqual([byPhone]);
  });

  it("the same booking delivered twice, or run twice, is one meeting and one history line", async () => {
    await deliver({ invitee: "DUP1", email: "dup@client.test" });
    await deliver({ invitee: "DUP1", email: "dup@client.test" });
    await h.ownerPool.query(
      "UPDATE webhook_events SET status = 'error' WHERE source_id = $1 AND event_key LIKE '%/invitees/DUP1'",
      [sourceId],
    );
    const [e] = (
      await h.ownerPool.query<{ id: string }>(
        "SELECT id FROM webhook_events WHERE source_id = $1 AND event_key LIKE '%/invitees/DUP1'",
        [sourceId],
      )
    ).rows;
    h.webhookQueue.push(Number(e!.id));
    await h.runWebhooks();
    expect(await backup("SELECT id FROM meetings WHERE external_id LIKE '%/invitees/DUP1'")).toHaveLength(1);
    const [lead] = await leadsBy("dup@client.test");
    expect(await activities(lead!.id, "meeting_booked")).toHaveLength(1);
  });

  it("required fields on the booking stage, or a lead already won, never lose the booking", async () => {
    const valueField = (await h.config()).fields.value!;
    await h.ownerPool.query("UPDATE stages SET required_field_ids = $1 WHERE id = $2", [
      [valueField],
      stages["Call booked"],
    ]);
    try {
      await deliver({ invitee: "REQ1", email: "req@client.test" });
    } finally {
      await h.ownerPool.query("UPDATE stages SET required_field_ids = '{}' WHERE id = $1", [
        stages["Call booked"],
      ]);
    }
    const [lead] = await leadsBy("req@client.test");
    expect(lead!.stage_id).not.toBe(stages["Call booked"]);
    expect(await meetingOf("REQ1")).toMatchObject({ lead_id: lead!.id, status: "scheduled" });
    expect(await eventOf("REQ1")).toMatchObject({ status: "done", problems: [{ code: "NOT_MOVED" }] });

    const won = await h.seedLead({
      ownerId: rep.id,
      name: "Won Lead",
      email: "won@client.test",
      stage: "Won",
    });
    await deliver({ invitee: "WON1", email: "won@client.test" });
    expect((await leadsBy("won@client.test"))[0]!.stage_id).toBe(stages.Won);
    expect((await meetingOf("WON1"))!.lead_id).toBe(won);
    // …and the event says why it stayed (final review, Important 2)
    expect(await eventOf("WON1")).toMatchObject({ status: "done", problems: [{ code: "ALREADY_CLOSED" }] });
  });

  it("a booking moving the lead into a stage that reminds before meetings sets that reminder (5C)", async () => {
    const t = await adminC.inject({
      method: "POST",
      url: "/api/v1/templates",
      payload: { name: "Before the call", category: "reminder", body: "See you {{meeting.time}}" },
    });
    expect(t.statusCode).toBe(201);
    const [was] = (
      await h.ownerPool.query<{ on_enter: unknown }>("SELECT on_enter FROM stages WHERE id = $1", [
        stages["Call booked"],
      ])
    ).rows;
    await h.ownerPool.query("UPDATE stages SET on_enter = $1 WHERE id = $2", [
      { rules: [{ id: newId(), type: "remind_before_meeting", hoursBefore: 2, templateId: t.json().id }] },
      stages["Call booked"],
    ]);
    try {
      const start = new Date(Date.now() + 30 * 3_600_000);
      await deliver({
        invitee: "REMIND1",
        email: "remind@client.test",
        name: "Rita Remind",
        start: start.toISOString(),
      });
      const [lead] = await leadsBy("remind@client.test");
      const tasks = await h.queryAll<{ type: string; template_id: string; due_at: Date }>(
        "SELECT type, template_id, due_at FROM tasks WHERE lead_id = $1",
        [lead!.id],
      );
      expect(tasks).toHaveLength(1);
      expect(tasks[0]).toMatchObject({ type: "whatsapp", template_id: t.json().id });
      expect(tasks[0]!.due_at.getTime()).toBe(start.getTime() - 2 * 3_600_000);
    } finally {
      await h.ownerPool.query("UPDATE stages SET on_enter = $1 WHERE id = $2", [
        was!.on_enter,
        stages["Call booked"],
      ]);
    }
  });

  it("a host who isn't in LUME: the meeting is the lead's owner's", async () => {
    const lead = await h.seedLead({ ownerId: rep.id, name: "Owned Lead", email: "owned@client.test" });
    await deliver({ invitee: "HOST1", email: "owned@client.test", host: "stranger@elsewhere.test" });
    expect(await meetingOf("HOST1")).toMatchObject({ lead_id: lead, owner_id: rep.id });
  });

  it("with new leads switched off, someone new makes no lead: the meeting is kept, unlinked, for the host", async () => {
    await adminC.inject({
      method: "PATCH",
      url: "/api/v1/integrations/calendly",
      payload: { createLeads: false },
    });
    try {
      await deliver({ invitee: "OFF1", email: "nobody@client.test" });
    } finally {
      await adminC.inject({
        method: "PATCH",
        url: "/api/v1/integrations/calendly",
        payload: { createLeads: true },
      });
    }
    expect(await leadsBy("nobody@client.test")).toHaveLength(0);
    expect(await meetingOf("OFF1")).toMatchObject({ lead_id: null, owner_id: host.id });
  });
});

describe("a cancellation (5B Task 6)", () => {
  it("cancelled: the meeting, history with the reason, the owner told, one Reschedule follow-up", async () => {
    await deliver({ invitee: "CAN1", email: "cancel@client.test", name: "Cara Cancel" });
    await deliver({
      invitee: "CAN1",
      event: "invitee.canceled",
      email: "cancel@client.test",
      reason: "Something came up",
    });
    await deliver({
      invitee: "CAN1",
      event: "invitee.canceled",
      email: "cancel@client.test",
      reason: "Something came up",
    });
    const [lead] = await leadsBy("cancel@client.test");
    expect((await meetingOf("CAN1"))!.status).toBe("cancelled");
    expect((await activities(lead!.id, "meeting_cancelled")).map((a) => a.payload.reason)).toEqual([
      "Something came up",
    ]);
    expect((await told("meeting_cancelled")).map((n) => n.title)).toEqual([
      "Cara Cancel cancelled Discovery call",
    ]);
    expect(
      await h.queryAll(
        "SELECT title, assignee_id FROM tasks WHERE lead_id = $1 AND title LIKE 'Reschedule:%'",
        [lead!.id],
      ),
    ).toEqual([{ title: "Reschedule: Cara Cancel", assignee_id: host.id }]);
  });

  it("a Calendly reschedule: the old meeting rescheduled and a new one booked, with no alarm and no follow-up", async () => {
    await deliver({ invitee: "RS1", email: "moves@client.test", name: "Mo Moves" });
    const before = (await told("meeting_cancelled")).length;
    await deliver({
      invitee: "RS1",
      event: "invitee.canceled",
      email: "moves@client.test",
      rescheduled: true,
    });
    await deliver({ invitee: "RS2", email: "moves@client.test", name: "Mo Moves" });
    const [lead] = await leadsBy("moves@client.test");
    expect((await meetingOf("RS1"))!.status).toBe("rescheduled");
    expect((await meetingOf("RS2"))!.status).toBe("scheduled");
    expect(await activities(lead!.id, "meeting_rescheduled")).toHaveLength(1);
    expect((await told("meeting_cancelled")).length).toBe(before);
    expect(
      await h.queryAll("SELECT id FROM tasks WHERE lead_id = $1 AND title LIKE 'Reschedule:%'", [lead!.id]),
    ).toEqual([]);
  });

  it("a cancellation for a booking LUME never saw changes nothing", async () => {
    await deliver({ invitee: "GHOST", event: "invitee.canceled", email: "ghost@client.test" });
    expect(await eventOf("GHOST", "invitee.canceled")).toMatchObject({ status: "done" });
    expect(await meetingOf("GHOST")).toBeUndefined();
  });
});

describe("the final review's fixes (5B)", () => {
  /** The booking stage reminds the lead 2 hours before their meeting, with a template. */
  async function withReminder<T>(fn: () => Promise<T>): Promise<T> {
    const t = await adminC.inject({
      method: "POST",
      url: "/api/v1/templates",
      payload: {
        name: `Reminder ${newId().slice(-6)}`,
        category: "reminder",
        body: "See you {{meeting.time}}",
      },
    });
    const [was] = (
      await h.ownerPool.query<{ on_enter: unknown }>("SELECT on_enter FROM stages WHERE id = $1", [
        stages["Call booked"],
      ])
    ).rows;
    await h.ownerPool.query("UPDATE stages SET on_enter = $1 WHERE id = $2", [
      { rules: [{ id: newId(), type: "remind_before_meeting", hoursBefore: 2, templateId: t.json().id }] },
      stages["Call booked"],
    ]);
    try {
      return await fn();
    } finally {
      await h.ownerPool.query("UPDATE stages SET on_enter = $1 WHERE id = $2", [
        was!.on_enter,
        stages["Call booked"],
      ]);
    }
  }
  const reminders = (lead: string) =>
    h.queryAll<{ status: string; due_at: Date }>(
      "SELECT status, due_at FROM tasks WHERE lead_id = $1 AND type = 'whatsapp' ORDER BY created_at",
      [lead],
    );
  const soon = (hours: number) => new Date(Date.now() + hours * 3_600_000);

  it("Important 1: a cancellation for a meeting whose lead was deleted still cancels it, once", async () => {
    await deliver({ invitee: "DEL1", email: "deleted@client.test" });
    const [lead] = await leadsBy("deleted@client.test");
    await h.queryAll("UPDATE leads SET deleted_at = now() WHERE id = $1 RETURNING id", [lead!.id]);
    expect(await leadsBy("deleted@client.test")).toEqual([]);
    await deliver({ invitee: "DEL1", event: "invitee.canceled", email: "deleted@client.test" });
    expect((await meetingOf("DEL1"))!.status).toBe("cancelled");
    expect(await eventOf("DEL1", "invitee.canceled")).toMatchObject({ status: "done" });
  });

  it("Important 3: a cancellation that arrives before its booking leaves no live meeting, no move, no notice", async () => {
    await deliver({ invitee: "EARLY1", event: "invitee.canceled", email: "early@client.test" });
    const notices = (await told("meeting_booked")).length;
    await deliver({ invitee: "EARLY1", email: "early@client.test", name: "Early Bird" });
    expect((await meetingOf("EARLY1"))!.status).toBe("cancelled");
    const [lead] = await leadsBy("early@client.test");
    expect(lead!.stage_id).not.toBe(stages["Call booked"]);
    expect((await told("meeting_booked")).length).toBe(notices);
  });

  it("Important 4: a meeting reminder follows its meeting — closed when it's cancelled or moved, set again for the new booking", async () => {
    await withReminder(async () => {
      const first = soon(30);
      await deliver({ invitee: "RM1", email: "reminded@client.test", start: first.toISOString() });
      const [lead] = await leadsBy("reminded@client.test");
      expect((await reminders(lead!.id)).map((r) => r.status)).toEqual(["open"]);
      // Calendly's reschedule: the old one closes, the new booking (the lead already in the stage) sets its own
      await deliver({
        invitee: "RM1",
        event: "invitee.canceled",
        email: "reminded@client.test",
        rescheduled: true,
      });
      const second = soon(50);
      await deliver({ invitee: "RM2", email: "reminded@client.test", start: second.toISOString() });
      const rs = await reminders(lead!.id);
      expect(rs.map((r) => r.status)).toEqual(["cancelled", "open"]);
      expect(rs[1]!.due_at.getTime()).toBe(second.getTime() - 2 * 3_600_000);
      // cancelled outright: its reminder closes
      await deliver({ invitee: "RM2", event: "invitee.canceled", email: "reminded@client.test" });
      expect((await reminders(lead!.id)).map((r) => r.status)).toEqual(["cancelled", "cancelled"]);
    });
  });

  it("Minor 7 (re-graded): a booking stage that clears the lead's follow-ups also clears their reminders, for whoever had them", async () => {
    const lead = await h.seedLead({ ownerId: host.id, name: "Cleared Lead", email: "cleared@client.test" });
    const task = newId();
    await h.queryAll(
      "INSERT INTO tasks (id, lead_id, assignee_id, title, due_at, series_id) VALUES ($1, $2, $3, 'Call back', now(), $1)",
      [task, lead, host.id],
    );
    const c = await h.ownerPool.connect();
    try {
      await c.query("BEGIN");
      await c.query("SELECT set_config('lume.user_id', $1, true)", [host.id]);
      await c.query(
        "INSERT INTO notifications (user_id, kind, task_id, lead_id, title) VALUES ($1, 'follow_up_due', $2, $3, 'Call back')",
        [host.id, task, lead],
      );
      await c.query("COMMIT");
    } finally {
      c.release();
    }
    const [was] = (
      await h.ownerPool.query<{ on_enter: unknown }>("SELECT on_enter FROM stages WHERE id = $1", [
        stages["Call booked"],
      ])
    ).rows;
    await h.ownerPool.query("UPDATE stages SET on_enter = $1 WHERE id = $2", [
      { rules: [{ id: newId(), type: "cancel_open_tasks" }] },
      stages["Call booked"],
    ]);
    try {
      await deliver({ invitee: "CLEAR1", email: "cleared@client.test", name: "Cleared Lead" });
    } finally {
      await h.ownerPool.query("UPDATE stages SET on_enter = $1 WHERE id = $2", [
        was!.on_enter,
        stages["Call booked"],
      ]);
    }
    expect(await h.queryAll("SELECT status FROM tasks WHERE id = $1", [task])).toEqual([
      { status: "cancelled" },
    ]);
    await expect
      .poll(
        async () =>
          (
            await backup<{ read_at: Date | null }>("SELECT read_at FROM notifications WHERE task_id = $1", [
              task,
            ])
          )[0]?.read_at,
      )
      .not.toBeNull();
  });

  it("Important 5: when the person Calendly runs as can't add leads, bookings wait; an admin's save runs it as them and they go through", async () => {
    await h.revokeGrant(admin.id, "leads.import");
    await deliver({ invitee: "WAIT1", email: "waiting@client.test" });
    expect(await eventOf("WAIT1")).toMatchObject({ status: "queued" });
    const [src] = (
      await h.ownerPool.query<{ status: string; attention_code: string }>(
        "SELECT status, attention_code FROM lead_sources WHERE id = $1",
        [sourceId],
      )
    ).rows;
    expect(src).toEqual({ status: "needs_attention", attention_code: "RUN_AS_ACCESS" });
    const hostC = await h.signIn(host);
    const saved = await hostC.inject({ method: "PATCH", url: "/api/v1/integrations/calendly", payload: {} });
    expect(saved.json()).toMatchObject({ status: "active", runAs: { id: host.id } });
    await h.runWebhooks();
    expect(await eventOf("WAIT1")).toMatchObject({ status: "done" });
    expect(await meetingOf("WAIT1")).toBeDefined();
  });
});
