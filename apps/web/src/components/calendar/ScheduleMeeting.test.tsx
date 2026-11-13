import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { calendarClient } from "@/lib/calendar/client";
import type { Scheduled } from "@/lib/calendar/types";
import { leadsClient } from "@/lib/leads/client";
import { whatsappClient } from "@/lib/whatsapp/client";
import { startCalendarConnect } from "./ConnectCalendar";
import { ScheduleMeeting, ScheduleSheet } from "./ScheduleMeeting";

vi.mock("@/lib/calendar/client", () => ({ calendarClient: { scheduleReady: vi.fn(), schedule: vi.fn() } }));
vi.mock("@/lib/leads/client", () => ({ leadsClient: { list: vi.fn(), prepareMessage: vi.fn() } }));
vi.mock("@/lib/whatsapp/client", () => ({ whatsappClient: { send: vi.fn() } }));
vi.mock("./ConnectCalendar", () => ({ startCalendarConnect: vi.fn(() => new Promise(() => {})) }));

const ok = <T,>(data: T) => ({ ok: true as const, status: 200, data });
const TZ = "Asia/Kolkata";
const MEERA = { id: "0190e0c0-0000-7000-8000-0000000000a1", name: "Meera Iyer" };
// 3:40 pm in Kolkata: the sheet offers 4 pm today.
const NOW = () => new Date("2026-11-13T10:10:00Z");
const scheduled = (whatsapp: Scheduled["whatsapp"]): Scheduled => ({
  meeting: {
    id: "m1",
    title: "Call with Meera",
    startsAt: "2026-11-13T10:30:00.000Z",
    endsAt: "2026-11-13T11:00:00.000Z",
    status: "scheduled",
    link: "https://meet.google.com/abc-defg-hij",
    location: "Google Meet",
    ownerId: "u1",
    matchedBy: "lume",
    outcomeNote: null,
    lead: { id: MEERA.id, name: MEERA.name, pipelineId: "p1", stageId: "s1" },
  } as never,
  link: "https://meet.google.com/abc-defg-hij",
  label: "November 13, Friday at 4 pm",
  message:
    "Hi Meera, here's the Google Meet link for our call on November 13, Friday at 4 pm: https://meet.google.com/abc-defg-hij",
  whatsapp,
});
const sheet = (lead: typeof MEERA | null = MEERA, onScheduled = vi.fn()) =>
  render(<ScheduleSheet lead={lead} tz={TZ} onClose={vi.fn()} onScheduled={onScheduled} now={NOW} />);

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(calendarClient.scheduleReady).mockResolvedValue(ok({ ready: true as const }));
});
afterEach(() => vi.restoreAllMocks());

describe("Schedule a meeting (owner, 2026-11-13)", () => {
  it("is the blue button, and opens the sheet", async () => {
    render(<ScheduleMeeting lead={MEERA} tz={TZ} />);
    const b = await screen.findByRole("button", { name: "Schedule a meeting" });
    expect(b).toHaveAttribute("data-variant", "primary");
    await userEvent.click(b);
    expect(await screen.findByRole("dialog", { name: "Schedule a meeting" })).toBeInTheDocument();
  });

  it("Google Calendar off for the business (integrations are optional): no button at all", async () => {
    vi.mocked(calendarClient.scheduleReady).mockResolvedValue(
      ok({ ready: false as const, why: "off" as const, message: "Google Calendar is off in LUME." }),
    );
    render(<ScheduleMeeting lead={MEERA} tz={TZ} />);
    await waitFor(() => expect(calendarClient.scheduleReady).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByRole("button", { name: "Schedule a meeting" })).toBeNull();
  });

  it("their own calendar not connected yet: the button stays, and its sheet connects it", async () => {
    vi.mocked(calendarClient.scheduleReady).mockResolvedValue(
      ok({ ready: false as const, why: "connect" as const, message: "Connect your Google Calendar." }),
    );
    render(<ScheduleMeeting lead={MEERA} tz={TZ} />);
    expect(await screen.findByRole("button", { name: "Schedule a meeting" })).toBeInTheDocument();
  });

  it("until Google Calendar lets LUME add meetings, says what's missing and asks for that permission", async () => {
    vi.mocked(calendarClient.scheduleReady).mockResolvedValue(
      ok({
        ready: false as const,
        why: "permission" as const,
        message: "Let LUME add meetings to your Google Calendar, so it can make the Meet link.",
      }),
    );
    sheet();
    expect(await screen.findByText("One more permission")).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Title" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Allow LUME to add meetings" }));
    expect(startCalendarConnect).toHaveBeenCalledWith({ addEvents: true });
  });

  it("Google Calendar off for the business: says so, with nothing to press but Close", async () => {
    vi.mocked(calendarClient.scheduleReady).mockResolvedValue(
      ok({ ready: false as const, why: "off" as const, message: "Google Calendar is off in LUME." }),
    );
    sheet();
    expect(await screen.findByText("Google Calendar is off")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();
  });

  it("from a lead's card: their name in the title, the next whole hour, 30 minutes; Schedule books it on the business's clock", async () => {
    vi.mocked(calendarClient.schedule).mockResolvedValue(
      ok(scheduled({ send: true, why: null, open: true })),
    );
    const onScheduled = vi.fn();
    sheet(MEERA, onScheduled);
    expect(await screen.findByRole("textbox", { name: "Title" })).toHaveValue("Call with Meera");
    // Who it's with, named by its row's label (a group, so the name is allowed: night QA 2026-11-13).
    expect(screen.getByRole("group", { name: "With" })).toHaveTextContent("Meera Iyer");
    expect(screen.getByLabelText("Day")).toHaveValue("2026-11-13");
    expect(screen.getByLabelText("Time")).toHaveValue("16:00");
    await userEvent.click(screen.getByRole("radio", { name: "45 min" }));
    await userEvent.type(screen.getByRole("textbox", { name: "Notes" }), "Bring the floor plan.");
    await userEvent.click(screen.getByRole("button", { name: "Schedule" }));
    expect(calendarClient.schedule).toHaveBeenCalledWith({
      leadId: MEERA.id,
      title: "Call with Meera",
      startsAt: "2026-11-13T10:30:00.000Z",
      minutes: 45,
      notes: "Bring the floor plan.",
    });
    expect(await screen.findByText("Meeting scheduled")).toBeInTheDocument();
    expect(onScheduled).toHaveBeenCalledWith(expect.objectContaining({ id: "m1" }));
    expect(screen.getByRole("link", { name: "meet.google.com/abc-defg-hij" })).toHaveAttribute(
      "href",
      "https://meet.google.com/abc-defg-hij",
    );
  });

  it("they wrote inside 24 hours: the message, ready to edit, goes from LUME's inbox at once", async () => {
    vi.mocked(calendarClient.schedule).mockResolvedValue(
      ok(scheduled({ send: true, why: null, open: true })),
    );
    vi.mocked(whatsappClient.send).mockResolvedValue(ok({ message: {} as never }));
    sheet();
    await userEvent.click(await screen.findByRole("button", { name: "Schedule" }));
    const wa = await screen.findByRole("region", { name: "Send the link on WhatsApp" });
    const box = within(wa).getByRole("textbox", { name: "Message" });
    expect(box).toHaveValue(scheduled({ send: true, why: null, open: true }).message);
    await userEvent.type(box, " See you!");
    await userEvent.click(screen.getByRole("button", { name: "Send on WhatsApp" }));
    expect(whatsappClient.send).toHaveBeenCalledWith(MEERA.id, {
      clientKey: expect.any(String),
      text: expect.stringMatching(/See you!$/),
    });
    expect(await screen.findByText("Sent on WhatsApp. It’s in Meera’s chat in LUME.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Done" })).toBeInTheDocument();
  });

  it("past 24 hours: says only a template can reach them from LUME, and offers WhatsApp with the message filled in", async () => {
    const why =
      "It's been more than 24 hours since Meera last wrote, so WhatsApp only lets LUME send them an approved template.";
    vi.mocked(calendarClient.schedule).mockResolvedValue(ok(scheduled({ send: false, why, open: true })));
    vi.mocked(leadsClient.prepareMessage).mockResolvedValue(
      ok({ url: "https://wa.me/919876543210?text=x" }) as never,
    );
    const tab = { opener: {}, location: { href: "" }, close: vi.fn() };
    vi.spyOn(window, "open").mockReturnValue(tab as never);
    sheet();
    await userEvent.click(await screen.findByRole("button", { name: "Schedule" }));
    expect(
      await screen.findByText(new RegExp(why.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Send on WhatsApp" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Open WhatsApp with this message" }));
    expect(leadsClient.prepareMessage).toHaveBeenCalledWith(
      MEERA.id,
      scheduled({ send: false, why, open: true }).message,
    );
    await waitFor(() => expect(tab.location.href).toBe("https://wa.me/919876543210?text=x"));
    expect(screen.getByText("WhatsApp opened with the message ready. Press send there.")).toBeInTheDocument();
  });

  it("no WhatsApp number: says so, and the only button is Done", async () => {
    vi.mocked(calendarClient.schedule).mockResolvedValue(
      ok(scheduled({ send: false, why: "Meera has no WhatsApp number in LUME.", open: false })),
    );
    sheet();
    await userEvent.click(await screen.findByRole("button", { name: "Schedule" }));
    expect(await screen.findByText("Meera has no WhatsApp number in LUME.")).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Message" })).toBeNull();
    expect(screen.getByRole("button", { name: "Done" })).toBeInTheDocument();
  });

  it("on the Calendar: finds the lead first; Schedule waits for one and a title follows the pick", async () => {
    vi.mocked(leadsClient.list).mockResolvedValue(
      ok({ items: [{ id: MEERA.id, name: MEERA.name }], nextCursor: null }) as never,
    );
    sheet(null);
    const schedule = await screen.findByRole("button", { name: "Schedule" });
    expect(schedule).toBeDisabled();
    await userEvent.type(screen.getByRole("searchbox", { name: "Find a lead" }), "Mee");
    await userEvent.click(await screen.findByRole("button", { name: "Meera Iyer" }));
    expect(screen.getByRole("textbox", { name: "Title" })).toHaveValue("Call with Meera");
    expect(schedule).toBeEnabled();
  });

  it("on the Calendar: a search still on its way when the box is cleared never fills the list", async () => {
    let answer!: (v: unknown) => void;
    vi.mocked(leadsClient.list).mockReturnValue(new Promise((r) => (answer = r)) as never);
    sheet(null);
    const box = await screen.findByRole("searchbox", { name: "Find a lead" });
    await userEvent.type(box, "Mee");
    await waitFor(() => expect(leadsClient.list).toHaveBeenCalled());
    await userEvent.clear(box);
    await userEvent.type(box, "M");
    answer(ok({ items: [{ id: MEERA.id, name: MEERA.name }], nextCursor: null }));
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByRole("button", { name: "Meera Iyer" })).toBeNull();
  });

  it("a refusal from the server is said in its own words, and the form stays", async () => {
    vi.mocked(calendarClient.schedule).mockResolvedValue({
      ok: false,
      status: 400,
      code: "MEETING_PAST",
      message: "Choose a time from now on.",
    } as never);
    sheet();
    await userEvent.click(await screen.findByRole("button", { name: "Schedule" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Choose a time from now on.");
    expect(screen.getByRole("textbox", { name: "Title" })).toBeInTheDocument();
  });
});
