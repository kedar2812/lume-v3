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
const match = (e: CalendarEvent, r: CalendarRules, calendarId = "primary") =>
  matchEvent(e, { leadsByEmail, rules: r, calendarId });

describe("calendar rules (5A, spec §2.2)", () => {
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

  it("with the attendee rule off, a lead attending is not enough", () => {
    expect(match(ev({ attendees: ["dana@client.test"] }), rules({ attendeeIsLead: false }))).toBeNull();
  });

  it("an event no rule keeps is not a meeting", () => {
    expect(match(ev(), rules())).toBeNull();
    expect(match(ev({ title: "Dentist" }), rules({ titleWords: ["Discovery call"] }))).toBeNull();
  });

  it("a title word keeps an unlinked meeting, matched as whole words and ignoring case", () => {
    const r = rules({ titleWords: ["Discovery call", "demo"] });
    expect(match(ev({ title: "discovery CALL with a new client" }), r)).toEqual({
      leadId: null,
      why: "title",
    });
    expect(match(ev({ title: "Product demo." }), r)).toEqual({ leadId: null, why: "title" });
  });

  it("a title word inside another word doesn't match", () => {
    const r = rules({ titleWords: ["demo", "call"] });
    expect(match(ev({ title: "Demolition site visit" }), r)).toBeNull();
    expect(match(ev({ title: "Recall the van" }), r)).toBeNull();
  });

  it("a blank title word matches nothing", () => {
    expect(match(ev({ title: "Anything" }), rules({ titleWords: ["", "   "] }))).toBeNull();
  });

  it("a title match is linked when an attendee is a lead, even with the attendee rule off", () => {
    expect(
      match(
        ev({ title: "Discovery call", attendees: ["dana@client.test"] }),
        rules({ attendeeIsLead: false, titleWords: ["discovery call"] }),
      ),
    ).toEqual({ leadId: LEAD, why: "title" });
  });

  it("a chosen calendar keeps every event on it, linked by attendee when it can be", () => {
    const r = rules({ attendeeIsLead: false, calendarIds: ["sales@group.test"] });
    expect(match(ev(), r, "sales@group.test")).toEqual({ leadId: null, why: "calendar" });
    expect(match(ev({ attendees: ["sam@client.test"] }), r, "sales@group.test")).toEqual({
      leadId: OTHER,
      why: "calendar",
    });
    expect(match(ev(), r, "primary")).toBeNull();
  });

  it("the first rule in order names why", () => {
    const r = rules({ titleWords: ["demo"], calendarIds: ["primary"] });
    expect(match(ev({ title: "demo", attendees: ["dana@client.test"] }), r)).toEqual({
      leadId: LEAD,
      why: "attendee",
    });
    expect(match(ev({ title: "demo" }), r)).toEqual({ leadId: null, why: "title" });
    expect(match(ev({ title: "lunch" }), r)).toEqual({ leadId: null, why: "calendar" });
  });

  it("refuses rules an admin can't have meant: too many words, overlong words", () => {
    expect(calendarRulesSchema.safeParse(rules({ titleWords: Array(51).fill("x") })).success).toBe(false);
    expect(calendarRulesSchema.safeParse(rules({ titleWords: ["x".repeat(101)] })).success).toBe(false);
    expect(calendarRulesSchema.safeParse({ attendeeIsLead: true }).success).toBe(false);
  });
});
