import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetCsrfForTests } from "@/lib/api";
import { calendarClient } from "./client";

const calls: { url: string; init: RequestInit }[] = [];
beforeEach(() => {
  resetCsrfForTests();
  calls.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push({ url, init });
      if (url.endsWith("/auth/csrf")) return new Response(JSON.stringify({ token: "t" }));
      return new Response(JSON.stringify({}), { status: 200 });
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

/** The last call the client made to the API (the CSRF fetch aside). */
const last = () => {
  const c = calls.filter((x) => !x.url.endsWith("/auth/csrf")).at(-1)!;
  return {
    method: c.init.method ?? "GET",
    url: new URL(c.url, "http://x"),
    body: c.init.body ? JSON.parse(String(c.init.body)) : undefined,
  };
};

describe("calendar client: a person's own connection", () => {
  it("reads, starts, completes, chooses calendars, refreshes and disconnects at the connection's routes", async () => {
    await calendarClient.connection();
    expect(last()).toMatchObject({ method: "GET", body: undefined });
    expect(last().url.pathname).toBe("/api/v1/calendar/connection");

    await calendarClient.connect();
    expect(last()).toMatchObject({ method: "POST" });
    expect(last().url.pathname).toBe("/api/v1/calendar/connect");

    await calendarClient.complete({ p: "sealed", s: "sig" });
    expect(last()).toMatchObject({ method: "POST", body: { p: "sealed", s: "sig" } });
    expect(last().url.pathname).toBe("/api/v1/calendar/complete");

    await calendarClient.chooseCalendars(["primary", "team@group.calendar.google.com"]);
    expect(last()).toMatchObject({
      method: "PATCH",
      body: { calendars: ["primary", "team@group.calendar.google.com"] },
    });
    expect(last().url.pathname).toBe("/api/v1/calendar/connection");

    await calendarClient.sync();
    expect(last()).toMatchObject({ method: "POST" });
    expect(last().url.pathname).toBe("/api/v1/calendar/connection/sync");

    await calendarClient.disconnect();
    expect(last()).toMatchObject({ method: "DELETE" });
    expect(last().url.pathname).toBe("/api/v1/calendar/connection");
  });

  it("switches the module on and off in Integrations", async () => {
    await calendarClient.setEnabled(true);
    expect(last()).toMatchObject({ method: "PUT", body: { enabled: true } });
    expect(last().url.pathname).toBe("/api/v1/integrations/google-calendar");
  });
});

describe("calendar client: meetings", () => {
  it("asks a range as ISO times, with only the filters given", async () => {
    const from = new Date("2026-10-01T00:00:00.000Z");
    const to = new Date("2026-10-08T00:00:00.000Z");
    await calendarClient.meetings({ from, to, ownerId: "u1", stageId: "s1" });
    const { url, method } = last();
    expect(method).toBe("GET");
    expect(url.pathname).toBe("/api/v1/meetings");
    expect(url.searchParams.get("from")).toBe("2026-10-01T00:00:00.000Z");
    expect(url.searchParams.get("to")).toBe("2026-10-08T00:00:00.000Z");
    expect(url.searchParams.get("ownerId")).toBe("u1");
    expect(url.searchParams.get("stageId")).toBe("s1");
    expect(url.searchParams.has("pipelineId")).toBe(false);
  });

  it("reads a lead's meetings and records an outcome at the meeting's own address", async () => {
    await calendarClient.leadMeetings("lead/1");
    expect(last().url.pathname).toBe("/api/v1/leads/lead%2F1/meetings");

    await calendarClient.patchMeeting("m1", { status: "no_show", outcomeNote: "Didn't join" });
    expect(last()).toMatchObject({
      method: "PATCH",
      body: { status: "no_show", outcomeNote: "Didn't join" },
    });
    expect(last().url.pathname).toBe("/api/v1/meetings/m1");

    await calendarClient.patchMeeting("m2", { leadId: "l9" });
    expect(last().body).toEqual({ leadId: "l9" });
  });
});

describe("calendar client: Calendly, the rules and the booking stage", () => {
  it("reads, connects, edits and disconnects Calendly", async () => {
    await calendarClient.calendly();
    expect(last()).toMatchObject({ method: "GET" });
    expect(last().url.pathname).toBe("/api/v1/integrations/calendly");

    await calendarClient.connectCalendly("cal-token-123");
    expect(last()).toMatchObject({ method: "POST", body: { token: "cal-token-123" } });

    await calendarClient.patchCalendly({ createLeads: false, phoneQuestion: null });
    expect(last()).toMatchObject({ method: "PATCH", body: { createLeads: false, phoneQuestion: null } });

    await calendarClient.disconnectCalendly();
    expect(last()).toMatchObject({ method: "DELETE" });
    expect(last().url.pathname).toBe("/api/v1/integrations/calendly");
  });

  it("reads and saves the calendar rules whole", async () => {
    await calendarClient.rules();
    expect(last()).toMatchObject({ method: "GET" });
    expect(last().url.pathname).toBe("/api/v1/settings/calendar");

    const rules = { attendeeIsLead: true, titleWords: ["Discovery call"], calendarIds: [] };
    await calendarClient.saveRules(rules);
    expect(last()).toMatchObject({ method: "PUT", body: { rules } });
  });

  it("sets and clears a pipeline's booking stage", async () => {
    await calendarClient.bookingStage("p1", "s9");
    expect(last()).toMatchObject({ method: "PATCH", body: { bookingStageId: "s9" } });
    expect(last().url.pathname).toBe("/api/v1/pipelines/p1");

    await calendarClient.bookingStage("p1", null);
    expect(last().body).toEqual({ bookingStageId: null });
  });
});
