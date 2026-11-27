import { describe, expect, it } from "vitest";
import {
  DEFAULT_CALENDAR_RULES,
  calendarRulesSchema,
  matchEvent,
  type CalendarEvent,
  type CalendarRules,
} from "./rules";

const LEAD = "0190e0c0-0000-7000-8000-0000000000a1";
const OTHER = "0190e0c0-0000-7000-8000-0000000000b1";
const leadsByEmail = new Map([
  ["dana@client.test", LEAD],
  ["sam@client.test", OTHER],
]);
const ev = (over: Partial<CalendarEvent> = {}): CalendarEvent => ({
  title: "Catch-up",
  organizer: "me@business.test",
  attendees: ["me@business.test"],
  ...over,
});
const rules = (over: Partial<CalendarRules> = {}): CalendarRules => ({ ...DEFAULT_CALENDAR_RULES, ...over });
const AT = new Date("2026-11-30T10:00:00Z");
const match = (
  e: CalendarEvent,
  r: CalendarRules,
  calendarId = "primary",
  customers: ReadonlyMap<string, Date> = new Map(),
) => matchEvent(e, { leadsByEmail, rules: r, calendarId, customers, startsAt: AT });

describe("calendar rules (5A, spec §2.2; only leads' calls, owner 2026-11-27)", () => {
  it("default: only 'attendee is a lead' is on, and the defaults are valid", () => {
    expect(DEFAULT_CALENDAR_RULES).toEqual({ attendeeIsLead: true, titleWords: [], calendarIds: [] });
    expect(calendarRulesSchema.safeParse(DEFAULT_CALENDAR_RULES).success).toBe(true);
  });

  it("an attendee who is a lead links the meeting to that lead, whatever the case of the address", () => {
    expect(match(ev({ attendees: ["me@business.test", "Dana@Client.TEST"] }), rules())).toEqual({
      leadId: LEAD,
      why: "attendee",
    });
  });

  it("the organiser counts as an attendee", () => {
    expect(match(ev({ organizer: "sam@client.test", attendees: [] }), rules())).toEqual({
      leadId: OTHER,
      why: "attendee",
    });
  });

  it("an event with no lead is never a meeting, whatever the rules (a personal event, another client's)", () => {
    expect(match(ev(), rules())).toBeNull();
    expect(
      match(ev({ title: "Discovery call with a new client" }), rules({ titleWords: ["Discovery call"] })),
    ).toBeNull();
    expect(match(ev(), rules({ calendarIds: ["sales@group.test"] }), "sales@group.test")).toBeNull();
  });

  it("the attendee rule is always on: rules saved with it off still bring a lead's call in", () => {
    expect(match(ev({ attendees: ["dana@client.test"] }), rules({ attendeeIsLead: false }))).toEqual({
      leadId: LEAD,
      why: "attendee",
    });
  });

  it("title words narrow it: only a lead's events with one of them, as whole words, any case", () => {
    const r = rules({ titleWords: ["Discovery call", "demo"] });
    expect(match(ev({ title: "discovery CALL", attendees: ["dana@client.test"] }), r)).toEqual({
      leadId: LEAD,
      why: "attendee",
    });
    expect(match(ev({ title: "Product demo.", attendees: ["dana@client.test"] }), r)?.leadId).toBe(LEAD);
    expect(match(ev({ title: "Weekly session", attendees: ["dana@client.test"] }), r)).toBeNull();
  });

  it("a title word inside another word doesn't count", () => {
    const r = rules({ titleWords: ["demo", "call"] });
    expect(match(ev({ title: "Demolition site visit", attendees: ["dana@client.test"] }), r)).toBeNull();
    expect(match(ev({ title: "Recall the van", attendees: ["dana@client.test"] }), r)).toBeNull();
  });

  it("blank title words narrow nothing", () => {
    expect(
      match(ev({ title: "Anything", attendees: ["dana@client.test"] }), rules({ titleWords: ["", "   "] }))
        ?.leadId,
    ).toBe(LEAD);
  });

  it("calendars narrow it: only a lead's events on one of them", () => {
    const r = rules({ calendarIds: ["sales@group.test"] });
    expect(match(ev({ attendees: ["sam@client.test"] }), r, "sales@group.test")?.leadId).toBe(OTHER);
    expect(match(ev({ attendees: ["sam@client.test"] }), r, "primary")).toBeNull();
  });

  it("both narrow together: the title word and the calendar", () => {
    const r = rules({ titleWords: ["demo"], calendarIds: ["primary"] });
    expect(match(ev({ title: "demo", attendees: ["dana@client.test"] }), r)?.leadId).toBe(LEAD);
    expect(match(ev({ title: "lunch", attendees: ["dana@client.test"] }), r)).toBeNull();
    expect(match(ev({ title: "demo", attendees: ["dana@client.test"] }), r, "other")).toBeNull();
  });

  it("a customer's session stays out: a lead won before the event starts is a client, not a sales call", () => {
    const won = new Map([[LEAD, new Date("2026-11-01T00:00:00Z")]]);
    expect(match(ev({ attendees: ["dana@client.test"] }), rules(), "primary", won)).toBeNull();
  });

  it("a call from before the win is still the lead's (its history stays)", () => {
    const won = new Map([[LEAD, new Date("2026-12-05T00:00:00Z")]]);
    expect(match(ev({ attendees: ["dana@client.test"] }), rules(), "primary", won)?.leadId).toBe(LEAD);
  });

  it("won at the very minute it starts: a customer already", () => {
    const won = new Map([[LEAD, AT]]);
    expect(match(ev({ attendees: ["dana@client.test"] }), rules(), "primary", won)).toBeNull();
  });

  it("a customer and a lead invited: the meeting is the lead's", () => {
    const won = new Map([[LEAD, new Date("2026-11-01T00:00:00Z")]]);
    expect(
      match(ev({ attendees: ["dana@client.test", "sam@client.test"] }), rules(), "primary", won)?.leadId,
    ).toBe(OTHER);
  });

  it("refuses rules an admin can't have meant: too many words, overlong words", () => {
    expect(calendarRulesSchema.safeParse(rules({ titleWords: Array(51).fill("x") })).success).toBe(false);
    expect(calendarRulesSchema.safeParse(rules({ titleWords: ["x".repeat(101)] })).success).toBe(false);
    expect(calendarRulesSchema.safeParse({ attendeeIsLead: true }).success).toBe(false);
  });
});
