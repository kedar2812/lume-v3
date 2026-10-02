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

describe("Settings → Calendar rules", () => {
  it("shows the three rules with green switches as saved", () => {
    render(<CalendarRules initial={RULES} calendars={CALENDARS} />);
    expect(screen.getByRole("switch", { name: "An attendee is a lead" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(screen.getByRole("switch", { name: "The title has a word" })).toHaveAttribute(
      "aria-checked",
      "false",
    );
    expect(screen.getByRole("switch", { name: "This calendar counts" })).toHaveAttribute(
      "aria-checked",
      "false",
    );
  });

  it("the sample week shows what the rules keep, and follows them as they change", async () => {
    render(<CalendarRules initial={RULES} calendars={CALENDARS} />);
    expect(screen.getByTestId("sample-count")).toHaveTextContent("3 of 11 events become meetings");
    await userEvent.click(screen.getByRole("switch", { name: "The title has a word" }));
    await userEvent.type(screen.getByRole("textbox", { name: "A word or phrase" }), "discovery call{Enter}");
    expect(screen.getByRole("button", { name: "Remove discovery call" })).toBeInTheDocument();
    expect(screen.getByTestId("sample-count")).toHaveTextContent("4 of 11 events become meetings");
  });

  it("saves the rules whole, and says when they're saved", async () => {
    vi.mocked(calendarClient.saveRules).mockImplementation(async (rules) => ok({ rules }));
    render(<CalendarRules initial={RULES} calendars={CALENDARS} />);
    await userEvent.click(screen.getByRole("switch", { name: "The title has a word" }));
    await userEvent.type(screen.getByRole("textbox", { name: "A word or phrase" }), "Pricing{Enter}");
    await userEvent.click(screen.getByRole("switch", { name: "This calendar counts" }));
    await userEvent.click(screen.getByRole("checkbox", { name: "Sales calls" }));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(calendarClient.saveRules).toHaveBeenCalledWith({
      attendeeIsLead: true,
      titleWords: ["Pricing"],
      calendarIds: ["sales@group.calendar.google.com"],
    });
    expect(await screen.findByRole("status")).toHaveTextContent("Saved");
  });

  it("a word switched off keeps nothing by title, even with words typed", async () => {
    vi.mocked(calendarClient.saveRules).mockImplementation(async (rules) => ok({ rules }));
    render(<CalendarRules initial={{ ...RULES, titleWords: ["Demo"] }} calendars={CALENDARS} />);
    expect(screen.getByRole("switch", { name: "The title has a word" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await userEvent.click(screen.getByRole("switch", { name: "The title has a word" }));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(calendarClient.saveRules).toHaveBeenCalledWith({
      attendeeIsLead: true,
      titleWords: [],
      calendarIds: [],
    });
  });

  it("with no calendar of their own connected, says how to choose calendars", async () => {
    render(<CalendarRules initial={RULES} calendars={[]} />);
    await userEvent.click(screen.getByRole("switch", { name: "This calendar counts" }));
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
    await userEvent.click(screen.getByRole("switch", { name: "An attendee is a lead" }));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("A word can be at most 100 characters.");
  });
});
