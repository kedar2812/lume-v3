import { ALL_GRANTS } from "@lume/core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startCalendlyFake, type CalendlyFake } from "../../../test/calendly-fake";
import { createHarness, type AuthedClient, type Harness } from "../../../test/harness";
import { bookingPlan } from "./booking";
import { CALENDLY_DEFAULTS } from "./config";

let h: Harness;
let fake: CalendlyFake;
let admin: AuthedClient;
let rep: AuthedClient;
const url = "/api/v1/integrations/calendly";
const BASE = "https://api.calendly.com/event_types";
const DISC = `${BASE}/DISC`;
const SESSION = `${BASE}/SESSION`;
const PAID = `${BASE}/PAID`;
const ASKS = `${BASE}/ASKS`;

beforeAll(async () => {
  fake = await startCalendlyFake();
  h = await createHarness({ preset: "coaching", calendlyEndpoint: fake.url });
  admin = await h.signIn(await h.seedUser({ grants: ALL_GRANTS, totp: true }));
  rep = await h.signIn(await h.seedUser({ grants: [{ key: "leads.view", scope: "own" }], totp: true }));
  expect((await admin.inject({ method: "POST", url, payload: { token: fake.token } })).statusCode).toBe(200);
});
afterAll(async () => {
  await h.close();
  await fake.close();
});
beforeEach(() => {
  fake.links = [
    {
      uri: DISC,
      name: "Discovery call",
      duration: 30,
      owner: "Maya Kapoor",
      locations: [{ kind: "google_conference" }],
    },
    { uri: SESSION, name: "Client check-in", duration: 45, owner: "Maya Kapoor" },
    { uri: PAID, name: "Paid consult", duration: 60, owner: "Maya Kapoor", paid: true },
    {
      uri: ASKS,
      name: "Strategy session",
      duration: 60,
      owner: "Maya Kapoor",
      questions: [{ name: "What's your budget?", required: true }],
    },
    { uri: `${BASE}/OFF`, name: "Old link", duration: 15, owner: "Maya Kapoor", active: false },
  ];
});
const links = () => admin.inject({ method: "GET", url: `${url}/links` });
const patch = (payload: Record<string, unknown>) => admin.inject({ method: "PATCH", url, payload });

describe("Calendly: which links are for leads, and LUME's booking link (owner 2026-11-27)", () => {
  it("lists the account's active links: every one for leads until chosen, and which LUME can book on", async () => {
    const r = await links();
    expect(r.statusCode).toBe(200);
    const b = r.json();
    expect(b.every).toBe(true);
    expect(b.bookWith).toBeNull();
    expect(
      b.links.map((l: { name: string; forLeads: boolean; bookable: boolean }) => [
        l.name,
        l.forLeads,
        l.bookable,
      ]),
    ).toEqual([
      ["Discovery call", true, true],
      ["Client check-in", true, true],
      ["Paid consult", true, false],
      ["Strategy session", true, false],
    ]);
    expect(b.links[3].why).toBe(`It asks "What's your budget?", which LUME can't answer for a lead.`);
    expect(r.body).not.toContain(fake.token);
  });

  it("only an admin sees or changes them", async () => {
    expect((await rep.inject({ method: "GET", url: `${url}/links` })).statusCode).toBe(403);
    expect((await rep.inject({ method: "PATCH", url, payload: { links: [DISC] } })).statusCode).toBe(403);
  });

  it("links chosen: only those are for leads, the others not", async () => {
    expect((await patch({ links: [DISC, DISC] })).statusCode).toBe(200);
    const b = (await links()).json();
    expect(b.every).toBe(false);
    expect(
      b.links.filter((l: { forLeads: boolean }) => l.forLeads).map((l: { uri: string }) => l.uri),
    ).toEqual([DISC]);
    const v = (await admin.inject({ method: "GET", url })).json();
    expect(v.settings.links).toEqual([DISC]);
    expect(b.saved).toEqual([DISC]);
  });

  it("LUME's booking link: one for leads that Calendly lets LUME book; anything else is refused in words", async () => {
    await patch({ links: [DISC, PAID, ASKS] });
    const notForLeads = await patch({ bookWith: SESSION });
    expect([notForLeads.statusCode, notForLeads.json().error.code]).toEqual([400, "BOOK_WITH_NOT_FOR_LEADS"]);
    const paid = await patch({ bookWith: PAID });
    expect([paid.statusCode, paid.json().error.message]).toEqual([
      400,
      "LUME can't book on Paid consult: It takes a payment, and Calendly doesn't let apps book those.",
    ]);
    expect((await patch({ bookWith: ASKS })).statusCode).toBe(400);
    expect((await patch({ bookWith: DISC })).statusCode).toBe(200);
    expect((await links()).json().bookWith).toBe(DISC);
  });

  it("the booking link taken off the links for leads, in the same save: refused, nothing changed", async () => {
    await patch({ links: [DISC], bookWith: DISC });
    const r = await patch({ links: [SESSION] });
    expect(r.json().error.code).toBe("BOOK_WITH_NOT_FOR_LEADS");
    expect((await links()).json().links.find((l: { uri: string }) => l.uri === DISC).forLeads).toBe(true);
  });

  it("Calendly down: said in LUME's words", async () => {
    fake.fail(503, 8);
    const r = await links();
    expect([r.statusCode, r.json().error.code]).toEqual([503, "CALENDLY_UNAVAILABLE"]);
    fake.fail(503, 0);
  });
});

describe("which links LUME can book on (Calendly's Scheduling API rules)", () => {
  const l = (over: Partial<Parameters<typeof bookingPlan>[0]> = {}) => ({
    uri: DISC,
    name: "Discovery call",
    duration: 30,
    schedulingUrl: "https://calendly.com/maya/disc",
    owner: "Maya",
    pooling: null,
    paid: false,
    locations: [],
    questions: [],
    ...over,
  });
  const S = CALENDLY_DEFAULTS;

  it("no location, no questions: bookable, nothing more to send", () => {
    expect(bookingPlan(l(), S)).toEqual({ ok: true, location: null, needsPhone: false, phoneQuestion: null });
  });
  it("a video link Calendly makes, or a place the link names: sent as the link has it", () => {
    expect(bookingPlan(l({ locations: [{ kind: "zoom_conference", location: null }] }), S)).toMatchObject({
      ok: true,
      location: { kind: "zoom_conference", fixed: null },
    });
    expect(
      bookingPlan(l({ locations: [{ kind: "physical", location: "Studio, Al Barsha" }] }), S),
    ).toMatchObject({
      location: { kind: "physical", fixed: "Studio, Al Barsha" },
    });
  });
  it("Calendly calls the invitee: bookable, with the lead's phone", () => {
    expect(bookingPlan(l({ locations: [{ kind: "outbound_call", location: null }] }), S)).toMatchObject({
      ok: true,
      needsPhone: true,
    });
  });
  it("only 'ask the invitee where': not bookable", () => {
    expect(bookingPlan(l({ locations: [{ kind: "ask_invitee", location: null }] }), S)).toEqual({
      ok: false,
      why: "It asks the invitee where to meet, which LUME can't answer for a lead.",
    });
  });
  it("a team's link (round robin): no location is sent", () => {
    expect(
      bookingPlan(l({ pooling: "round_robin", locations: [{ kind: "ask_invitee", location: null }] }), S),
    ).toMatchObject({
      ok: true,
      location: null,
    });
  });
  it("the required phone question set in Settings is answered with the phone; an optional question is left", () => {
    const q = l({
      questions: [
        { name: "Phone number", required: true, enabled: true },
        { name: "Anything else?", required: false, enabled: true },
        { name: "Old question", required: true, enabled: false },
      ],
    });
    expect(bookingPlan(q, { ...S, phoneQuestion: "Phone number" })).toEqual({
      ok: true,
      location: null,
      needsPhone: true,
      phoneQuestion: "Phone number",
    });
    expect(bookingPlan(q, S).ok).toBe(false);
  });
});
