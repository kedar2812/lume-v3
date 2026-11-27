import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { calendarClient } from "@/lib/calendar/client";
import { CalendarRules } from "./CalendarRules";

vi.mock("@/lib/calendar/client", () => ({ calendarClient: { saveRules: vi.fn() } }));
const ok = <T,>(data: T) => ({ ok: true as const, status: 200, data });
const RULES = { attendeeIsLead: true, titleWords: [], calendarIds: [] };
const CALENDARS = [
  { id: "maya@brightpath.test", name: "Maya Kapoor" },
  { id: "sales@group.calendar.google.com", name: "Sales calls" },
];

beforeEach(() => vi.clearAllMocks());

// Only leads' calls (owner 2026-11-27): the first rule is always on; the title words and calendars only narrow it.
describe("Settings → Calendar rules", () => {
  it("the first rule is always on, and says what never comes in; the two others narrow it, off as saved", () => {
    render(<CalendarRules initial={RULES} calendars={CALENDARS} />);
    expect(screen.queryByRole("switch", { name: /attendee/i })).not.toBeInTheDocument();
    expect(screen.getByText("Only events with a lead")).toBeInTheDocument();
    expect(screen.getByText("Always on")).toBeInTheDocument();
    expect(
      screen.getByText(/Personal events, and sessions with leads who are already customers, never come in/),
    ).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Only titles with a word" })).toHaveAttribute(
      "aria-checked",
      "false",
    );
    expect(screen.getByRole("switch", { name: "Only these calendars" })).toHaveAttribute(
      "aria-checked",
      "false",
    );
  });

  it("the sample week: only the leads' events, never an unknown address or a customer's session", async () => {
    render(<CalendarRules initial={RULES} calendars={CALENDARS} />);
    expect(screen.getByTestId("sample-count")).toHaveTextContent("3 of 12 events become meetings");
    const session = screen.getByText("Weekly session").closest("div")!;
    expect(session).not.toHaveAttribute("data-kept");
    await userEvent.click(screen.getByRole("switch", { name: "Only titles with a word" }));
    await userEvent.type(screen.getByRole("textbox", { name: "A word or phrase" }), "discovery call{Enter}");
    expect(screen.getByRole("button", { name: "Remove discovery call" })).toBeInTheDocument();
    // Narrowed: Dana's discovery call; the new enquiry by an address that's no lead's still stays out.
    expect(screen.getByTestId("sample-count")).toHaveTextContent("1 of 12 events become meetings");
  });

  it("only these calendars narrows the sample to the leads' events on them", async () => {
    render(<CalendarRules initial={RULES} calendars={CALENDARS} />);
    await userEvent.click(screen.getByRole("switch", { name: "Only these calendars" }));
    // On, with none ticked yet: nothing narrowed.
    expect(screen.getByTestId("sample-count")).toHaveTextContent("3 of 12 events become meetings");
    await userEvent.click(screen.getByRole("checkbox", { name: "Sales calls" }));
    expect(screen.getByTestId("sample-count")).toHaveTextContent("1 of 12 events become meetings");
  });

  it("saves the rules whole, the first always on, and says when they're saved", async () => {
    vi.mocked(calendarClient.saveRules).mockImplementation(async (rules) => ok({ rules }));
    render(<CalendarRules initial={{ ...RULES, attendeeIsLead: false }} calendars={CALENDARS} />);
    await userEvent.click(screen.getByRole("switch", { name: "Only titles with a word" }));
    await userEvent.type(screen.getByRole("textbox", { name: "A word or phrase" }), "Pricing{Enter}");
    await userEvent.click(screen.getByRole("switch", { name: "Only these calendars" }));
    await userEvent.click(screen.getByRole("checkbox", { name: "Sales calls" }));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(calendarClient.saveRules).toHaveBeenCalledWith({
      attendeeIsLead: true,
      titleWords: ["Pricing"],
      calendarIds: ["sales@group.calendar.google.com"],
    });
    expect(await screen.findByRole("status")).toHaveTextContent("Saved");
  });

  it("words switched off narrow nothing, even with words typed", async () => {
    vi.mocked(calendarClient.saveRules).mockImplementation(async (rules) => ok({ rules }));
    render(<CalendarRules initial={{ ...RULES, titleWords: ["Demo"] }} calendars={CALENDARS} />);
    expect(screen.getByRole("switch", { name: "Only titles with a word" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await userEvent.click(screen.getByRole("switch", { name: "Only titles with a word" }));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(calendarClient.saveRules).toHaveBeenCalledWith({
      attendeeIsLead: true,
      titleWords: [],
      calendarIds: [],
    });
  });

  it("with no calendar of their own connected, says how to choose calendars", async () => {
    render(<CalendarRules initial={RULES} calendars={[]} />);
    await userEvent.click(screen.getByRole("switch", { name: "Only these calendars" }));
    expect(
      screen.getByText(/Connect your own calendar in Settings → Calendar to choose its calendars/),
    ).toBeInTheDocument();
  });

  it("says the server's refusal", async () => {
    vi.mocked(calendarClient.saveRules).mockResolvedValue({
      ok: false,
      status: 400,
      code: "VALIDATION",
      message: "A word can be at most 100 characters.",
    });
    render(<CalendarRules initial={RULES} calendars={CALENDARS} />);
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("A word can be at most 100 characters.");
  });
});
