import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { RunLead } from "@/lib/autopilot/types";
import { LeadList } from "./LeadList";

const lead = (o: Partial<RunLead> & { leadId: string; name: string }): RunLead => ({
  state: "up_next",
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
const LEADS = [
  lead({ leadId: "a", name: "Meera Iyer", state: "writing" }),
  lead({ leadId: "b", name: "Rohan Gupta", state: "ready" }),
  lead({ leadId: "c", name: "Sneha Reddy", state: "stopped" }),
  lead({ leadId: "d", name: "Kabir Shah", state: "skipped", reason: "No WhatsApp number" }),
  lead({ leadId: "e", name: "Isha Menon", state: "skipped", reason: "No WhatsApp number" }),
];

/** The leads in a run (Autopilot spec 2026-10-19 §2): each with its state, the one LUME AI is on marked. */
describe("LeadList", () => {
  it("each lead with its state in words; the one LUME AI is on says so", () => {
    render(<LeadList leads={LEADS} currentId="a" watchedId="a" onWatch={vi.fn()} />);
    const list = screen.getByRole("list", { name: "Leads in this run" });
    const meera = within(list).getByRole("button", { name: /Meera Iyer/ });
    expect(meera).toHaveTextContent("Writing");
    expect(meera).toHaveAccessibleName("Meera Iyer, Writing, LUME AI is on this lead");
    expect(meera).toHaveAttribute("aria-pressed", "true");
    expect(within(list).getByRole("button", { name: /Rohan Gupta/ })).toHaveTextContent("Ready for you");
    expect(within(list).getByRole("button", { name: /Sneha Reddy/ })).toHaveTextContent("Stopped");
  });

  it("clicking a lead watches it; LUME AI carries on elsewhere", async () => {
    const onWatch = vi.fn();
    render(<LeadList leads={LEADS} currentId="a" watchedId="a" onWatch={onWatch} />);
    await userEvent.click(screen.getByRole("button", { name: /Rohan Gupta/ }));
    expect(onWatch).toHaveBeenCalledWith("b");
  });

  it("the skipped fold away at the end, with why", async () => {
    render(<LeadList leads={LEADS} currentId="a" watchedId="a" onWatch={vi.fn()} />);
    expect(screen.queryByText("Kabir Shah")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "2 skipped" }));
    expect(screen.getByText("Kabir Shah")).toBeInTheDocument();
    expect(screen.getAllByText("No WhatsApp number")).toHaveLength(2);
  });
});
