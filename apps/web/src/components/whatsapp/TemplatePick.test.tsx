import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { whatsappClient } from "@/lib/whatsapp/client";
import type { WaTemplateState, WaThreadMessage } from "@/lib/whatsapp/types";
import { TemplatePick } from "./TemplatePick";

vi.mock("@/lib/whatsapp/client", () => ({
  whatsappClient: { templateState: vi.fn(), sendTemplate: vi.fn() },
}));
const ok = <T,>(data: T) => ({ ok: true as const, status: 202, data });
const STATE: NonNullable<WaTemplateState> = {
  number: { id: "n1", display: "+91 90000 00001" },
  reason: null,
  options: [
    {
      submissionId: "s1",
      name: "Gentle nudge",
      category: "MARKETING",
      preview: "Hi Sneha, still keen on a visit this week?",
      missing: [],
      cost: { amount: 0.86, currency: "INR", asOf: "2026-10-18" },
    },
    {
      submissionId: "s2",
      name: "Visit reminder",
      category: "UTILITY",
      preview: "Hi Sneha, your visit on {{meeting.date}} is confirmed.",
      missing: ["Meeting date"],
      cost: null,
    },
  ],
};
const sent: WaThreadMessage = {
  id: "a1",
  direction: "out",
  at: "2026-10-20T06:00:00.000Z",
  text: "Hi Sneha, still keen on a visit this week?",
  media: null,
  sentBy: { id: "u1", name: "Priya" },
  status: "queued",
  problem: null,
  outboxId: "o1",
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(whatsappClient.templateState).mockResolvedValue(ok(STATE));
  vi.mocked(whatsappClient.sendTemplate).mockResolvedValue(ok({ message: sent }));
});

describe("sending an approved template from the reply box (plan W3b-2 Task 7)", () => {
  it("each approved template in the lead's words, what WhatsApp charges, and Send", async () => {
    const onSent = vi.fn();
    render(<TemplatePick leadId="l1" leadName="Sneha Reddy" onSent={onSent} />);
    const nudge = await screen.findByRole("radio", { name: /Gentle nudge/ });
    expect(nudge).toHaveTextContent("Hi Sneha, still keen on a visit this week?");
    expect(nudge).toHaveTextContent("WhatsApp charges about ₹0.86 + GST for this.");
    expect(screen.getByText("From +91 90000 00001 · or wait for Sneha's reply")).toBeInTheDocument();
    await userEvent.click(nudge);
    await userEvent.click(screen.getByRole("button", { name: "Send template" }));
    expect(whatsappClient.sendTemplate).toHaveBeenCalledWith("l1", {
      submissionId: "s1",
      clientKey: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
    await waitFor(() => expect(onSent).toHaveBeenCalledWith(sent));
  });

  it("one missing a value says what, and can't be sent", async () => {
    render(<TemplatePick leadId="l1" leadName="Sneha Reddy" onSent={vi.fn()} />);
    const reminder = await screen.findByRole("radio", { name: /Visit reminder/ });
    expect(reminder).toHaveTextContent("Needs Meeting date first");
    expect(reminder).toHaveAttribute("aria-disabled", "true");
    await userEvent.click(reminder);
    expect(screen.getByRole("button", { name: "Send template" })).toBeDisabled();
  });

  it("nothing approved: nothing here", async () => {
    vi.mocked(whatsappClient.templateState).mockResolvedValue(ok({ ...STATE, options: [] }));
    const { container } = render(<TemplatePick leadId="l1" leadName="Sneha Reddy" onSent={vi.fn()} />);
    await waitFor(() => expect(whatsappClient.templateState).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it("a send LUME refuses says why, and keeps the choice", async () => {
    vi.mocked(whatsappClient.sendTemplate).mockResolvedValue({
      ok: false,
      status: 409,
      code: "PAID_LIMIT",
      message: "This month's paid WhatsApp messages are used up (1,000 of 1,000). An admin can ask for more.",
    } as never);
    render(<TemplatePick leadId="l1" leadName="Sneha Reddy" onSent={vi.fn()} />);
    await userEvent.click(await screen.findByRole("radio", { name: /Gentle nudge/ }));
    await userEvent.click(screen.getByRole("button", { name: "Send template" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("used up (1,000 of 1,000)");
    expect(screen.getByRole("radio", { name: /Gentle nudge/ })).toHaveAttribute("aria-checked", "true");
  });
});
