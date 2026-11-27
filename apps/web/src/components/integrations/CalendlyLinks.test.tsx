import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { calendarClient } from "@/lib/calendar/client";
import type { CalendlyLinks as Links } from "@/lib/calendar/types";
import { CalendlyLinks } from "./CalendlyLinks";

vi.mock("@/lib/calendar/client", () => ({ calendarClient: { calendlyLinks: vi.fn() } }));
const ok = <T,>(data: T) => ({ ok: true as const, status: 200, data });
const link = (id: string, name: string, over: Partial<Links["links"][number]> = {}) => ({
  uri: `https://api.calendly.com/event_types/${id}`,
  name,
  duration: 30,
  schedulingUrl: `https://calendly.com/maya/${id}`,
  owner: "Maya Kapoor",
  forLeads: true,
  bookable: true,
  ...over,
});
const DISCOVERY = link("disc", "Discovery call");
const SESSION = link("sess", "Client check-in", { duration: 45 });
const PAID = link("paid", "Paid consult", {
  bookable: false,
  why: "It takes a payment, and Calendly doesn't let apps book those.",
});
const answer = (data: Links) => vi.mocked(calendarClient.calendlyLinks).mockResolvedValue(ok(data));

beforeEach(() => vi.clearAllMocks());

describe("Calendly: which links are for leads (owner 2026-11-27)", () => {
  it("every link, never chosen: says so, each link on, with its length and whose it is", async () => {
    answer({ every: true, bookWith: null, links: [DISCOVERY, SESSION] });
    render(<CalendlyLinks onSave={vi.fn()} />);
    expect(await screen.findByRole("status")).toHaveTextContent(
      "LUME takes bookings from every Calendly link. Choose the ones for leads.",
    );
    expect(screen.getByRole("switch", { name: "Discovery call" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("switch", { name: "Client check-in" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByText("45 min · Maya Kapoor")).toBeInTheDocument();
  });

  it("a link switched off: the rest are saved as the links for leads, and the notice goes", async () => {
    answer({ every: true, bookWith: null, links: [DISCOVERY, SESSION] });
    const onSave = vi.fn().mockResolvedValue(null);
    render(<CalendlyLinks onSave={onSave} />);
    await userEvent.click(await screen.findByRole("switch", { name: "Client check-in" }));
    expect(onSave).toHaveBeenCalledWith({ links: [DISCOVERY.uri] });
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Client check-in" })).toHaveAttribute("aria-checked", "false");
  });

  it("the booking link: only links for leads that LUME can book; those it can't say why", async () => {
    answer({ every: false, bookWith: null, links: [DISCOVERY, { ...SESSION, forLeads: false }, PAID] });
    render(<CalendlyLinks onSave={vi.fn()} />);
    const pick = await screen.findByRole("combobox", { name: "LUME's booking link" });
    expect([...(pick as HTMLSelectElement).options].map((o) => o.text)).toEqual([
      "None: LUME books calls on Google Calendar only",
      "Discovery call (30 min)",
    ]);
    expect(screen.getByRole("list", { name: "Links LUME can't book on" })).toHaveTextContent(
      "Paid consult: It takes a payment, and Calendly doesn't let apps book those.",
    );
  });

  it("picking the booking link saves it", async () => {
    answer({ every: false, bookWith: null, links: [DISCOVERY] });
    const onSave = vi.fn().mockResolvedValue(null);
    render(<CalendlyLinks onSave={onSave} />);
    await userEvent.selectOptions(
      await screen.findByRole("combobox", { name: "LUME's booking link" }),
      "Discovery call (30 min)",
    );
    expect(onSave).toHaveBeenCalledWith({ bookWith: DISCOVERY.uri });
  });

  it("the booking link switched off as a link for leads: it stops being the booking link too", async () => {
    answer({ every: false, bookWith: DISCOVERY.uri, links: [DISCOVERY, SESSION] });
    const onSave = vi.fn().mockResolvedValue(null);
    render(<CalendlyLinks onSave={onSave} />);
    await userEvent.click(await screen.findByRole("switch", { name: "Discovery call" }));
    expect(onSave).toHaveBeenCalledWith({ links: [SESSION.uri], bookWith: null });
    expect(screen.getByRole("combobox", { name: "LUME's booking link" })).toHaveValue("");
  });

  it("a save LUME refuses: it says why and puts the switch back", async () => {
    answer({ every: false, bookWith: null, links: [DISCOVERY] });
    const onSave = vi.fn().mockResolvedValue("Calendly isn't connected.");
    render(<CalendlyLinks onSave={onSave} />);
    await userEvent.click(await screen.findByRole("switch", { name: "Discovery call" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Calendly isn't connected.");
    expect(screen.getByRole("switch", { name: "Discovery call" })).toHaveAttribute("aria-checked", "true");
  });

  it("a saved link Calendly didn't list this time stays saved when another is switched", async () => {
    const OFF = "https://api.calendly.com/event_types/off";
    answer({
      every: false,
      saved: [OFF, DISCOVERY.uri],
      bookWith: null,
      links: [DISCOVERY, { ...SESSION, forLeads: false }],
    });
    const onSave = vi.fn().mockResolvedValue(null);
    render(<CalendlyLinks onSave={onSave} />);
    await userEvent.click(await screen.findByRole("switch", { name: "Client check-in" }));
    expect(onSave).toHaveBeenCalledWith({ links: [OFF, DISCOVERY.uri, SESSION.uri] });
  });

  it("Calendly can't be read: says so, with Try again", async () => {
    vi.mocked(calendarClient.calendlyLinks)
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
        code: "CALENDLY_UNAVAILABLE",
        message: "LUME couldn't reach Calendly. Try again in a minute.",
      })
      .mockResolvedValueOnce(ok({ every: false, bookWith: null, links: [DISCOVERY] }));
    render(<CalendlyLinks onSave={vi.fn()} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("LUME couldn't reach Calendly.");
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("switch", { name: "Discovery call" })).toBeInTheDocument();
  });

  it("no active links: says so", async () => {
    answer({ every: true, bookWith: null, links: [] });
    render(<CalendlyLinks onSave={vi.fn()} />);
    expect(await screen.findByText("This Calendly account has no active links yet.")).toBeInTheDocument();
  });
});
