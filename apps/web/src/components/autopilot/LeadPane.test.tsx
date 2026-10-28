import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { RunAsk, RunLead } from "@/lib/autopilot/types";
import { LeadPane } from "./LeadPane";

const lead = (o: Partial<RunLead> & { leadId: string; name: string }): RunLead => ({
  state: "talking",
  reason: null,
  card: null,
  thought: null,
  repliedAt: null,
  draft: null,
  nextAt: null,
  lastSentAt: null,
  updatedAt: "2026-10-26T09:00:00.000Z",
  ...o,
});
const leads = [
  lead({ leadId: "a", name: "Meera Iyer", state: "writing", draft: { kind: "reply" } as RunLead["draft"] }),
  lead({
    leadId: "b",
    name: "Rohan Gupta",
    state: "needs_you",
    card: { headline: "Asked for a discount", quote: null },
  }),
  lead({
    leadId: "c",
    name: "Sneha Reddy",
    state: "ready",
    card: { headline: "Site visit agreed", quote: null },
  }),
  lead({ leadId: "d", name: "Kabir Shah", state: "sent" }),
  lead({ leadId: "e", name: "Isha Menon", state: "skipped", reason: "No WhatsApp number" }),
];
const asks: RunAsk[] = [];
const base = {
  leads,
  asks,
  tz: "Asia/Kolkata",
  now: new Date("2026-10-26T10:00:00.000Z"),
  currentId: "a",
  selectedId: "a",
  onSelect: vi.fn(),
  onFilter: vi.fn(),
};

/** The leads pane of the LUME AI page (plan 2026-10-28, artboards 1–3): one list, one filter, one line each. */
describe("LeadPane", () => {
  it("the filter says how many each holds; All lists everyone but the skipped, each in one line", () => {
    render(<LeadPane {...base} filter="all" />);
    const show = screen.getByRole("radiogroup", { name: "Show" });
    expect(
      within(show)
        .getAllByRole("radio")
        .map((r) => r.textContent),
    ).toEqual(["Needs you 1", "Ready 1", "All 4"]);
    const list = screen.getByRole("list", { name: "Leads in this run" });
    expect(
      within(list)
        .getAllByRole("button")
        .map((b) => b.getAttribute("aria-label")),
    ).toEqual([
      "Meera Iyer, Writing a reply, LUME AI is on this lead",
      "Rohan Gupta, Needs you · Asked for a discount",
      "Sneha Reddy, Ready · Site visit agreed",
      "Kabir Shah, Messaged",
    ]);
    // Initials on a neutral circle, never a colour per lead.
    expect(within(list).getByText("MI")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Meera Iyer/ })).toHaveAttribute("aria-pressed", "true");
  });

  it("a dot only where it matters, and the words say the same as the dot", () => {
    render(<LeadPane {...base} filter="all" />);
    const dots = Array.from(document.querySelectorAll("[data-dot]")).map((d) => d.getAttribute("data-dot"));
    expect(dots).toEqual(["writing", "needs", "ready"]);
  });

  it("Needs you and Ready show only theirs; empty, they say so", () => {
    const { rerender } = render(<LeadPane {...base} filter="needs" />);
    expect(screen.getAllByRole("button", { name: /, Needs you/ })).toHaveLength(1);
    expect(screen.queryByRole("button", { name: /Kabir Shah/ })).toBeNull();
    rerender(<LeadPane {...base} leads={leads.filter((l) => l.state !== "ready")} filter="ready" />);
    expect(screen.getByText("No one is ready for you yet.")).toBeInTheDocument();
    rerender(<LeadPane {...base} leads={leads.filter((l) => l.state !== "needs_you")} filter="needs" />);
    expect(screen.getByText("Nobody needs you right now.")).toBeInTheDocument();
  });

  it("choosing a filter or a lead says so to the page", async () => {
    const onSelect = vi.fn();
    const onFilter = vi.fn();
    render(<LeadPane {...base} filter="all" onSelect={onSelect} onFilter={onFilter} />);
    await userEvent.click(screen.getByRole("radio", { name: "Ready 1" }));
    expect(onFilter).toHaveBeenCalledWith("ready");
    await userEvent.click(screen.getByRole("button", { name: /Kabir Shah/ }));
    expect(onSelect).toHaveBeenCalledWith("d");
  });

  it("the skipped fold away under All, each with why", async () => {
    render(<LeadPane {...base} filter="all" />);
    await userEvent.click(screen.getByRole("button", { name: "1 skipped" }));
    expect(screen.getByText("No WhatsApp number")).toBeInTheDocument();
  });
});
