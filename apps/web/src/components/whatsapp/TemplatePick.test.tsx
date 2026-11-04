import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { whatsappClient } from "@/lib/whatsapp/client";
import type { WaTemplateState, WaThreadMessage } from "@/lib/whatsapp/types";
import { SENT_MS, TemplatePick, forgetTemplatePicks } from "./TemplatePick";

vi.mock("@/lib/whatsapp/client", () => ({
  whatsappClient: { templateState: vi.fn(), sendTemplate: vi.fn(), recommendTemplate: vi.fn() },
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
  lumeAi: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  forgetTemplatePicks();
  vi.mocked(whatsappClient.recommendTemplate).mockResolvedValue(
    ok({
      pick: { submissionId: "s1", why: "Sneha went quiet after asking about visits: a gentle nudge fits." },
    }),
  );
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

describe("Recommended by LUME AI (owner, 2026-10-31)", () => {
  it("LUME AI's pick, with why, and Send sends it", async () => {
    const onSent = vi.fn();
    render(<TemplatePick leadId="l1" leadName="Sneha Reddy" ai onSent={onSent} />);
    const rec = await screen.findByRole("region", { name: "Recommended by LUME AI" });
    await waitFor(() => expect(rec).toHaveTextContent("Gentle nudge"));
    expect(rec).toHaveTextContent("Hi Sneha, still keen on a visit this week?");
    expect(rec).toHaveTextContent(
      "Why this one: Sneha went quiet after asking about visits: a gentle nudge fits.",
    );
    expect(rec).toHaveTextContent("WhatsApp charges about ₹0.86 + GST for this.");
    await userEvent.click(screen.getByRole("button", { name: "Send template" }));
    expect(whatsappClient.sendTemplate).toHaveBeenCalledWith("l1", {
      submissionId: "s1",
      clientKey: expect.any(String),
    });
    await waitFor(() => expect(onSent).toHaveBeenCalledWith(sent));
  });

  it("sent: the card says so with a tick, then folds itself away to Send a template (owner 2026-11-04)", async () => {
    const onSent = vi.fn();
    const { unmount } = render(<TemplatePick leadId="l1" leadName="Sneha Reddy" ai onSent={onSent} />);
    await screen.findByText("Gentle nudge");
    await userEvent.click(screen.getByRole("button", { name: "Send template" }));
    // At once: the message is in the chat, and the card confirms it.
    expect(await screen.findByRole("status")).toHaveTextContent("Sent to Sneha");
    expect(onSent).toHaveBeenCalledWith(sent);
    expect(screen.queryByRole("button", { name: "Send template" })).toBeNull();
    // Then it closes by itself, leaving only the quiet way to another template.
    expect(
      await screen.findByRole("button", { name: "Send a template" }, { timeout: SENT_MS + 2000 }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Recommended by LUME AI" })).toBeNull();
    // Opened again in this session: folded, never the same recommendation to send twice.
    unmount();
    render(<TemplatePick leadId="l1" leadName="Sneha Reddy" ai onSent={vi.fn()} />);
    expect(await screen.findByRole("button", { name: "Send a template" })).toBeInTheDocument();
  });

  it("the same from the list of templates", async () => {
    render(<TemplatePick leadId="l1" leadName="Sneha Reddy" onSent={vi.fn()} />);
    await userEvent.click(await screen.findByRole("radio", { name: /Gentle nudge/ }));
    await userEvent.click(screen.getByRole("button", { name: "Send template" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Sent to Sneha");
    expect(
      await screen.findByRole("button", { name: "Send a template" }, { timeout: SENT_MS + 2000 }),
    ).toBeInTheDocument();
  });

  it("while LUME AI chooses, it says so; Dismiss works then too", async () => {
    vi.mocked(whatsappClient.recommendTemplate).mockReturnValue(new Promise(() => {}));
    render(<TemplatePick leadId="l1" leadName="Sneha Reddy" ai onSent={vi.fn()} />);
    expect(await screen.findByText("LUME AI is choosing a template for Sneha…")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("region", { name: "Recommended by LUME AI" })).toBeNull();
    expect(screen.getByRole("button", { name: "Send a template" })).toBeInTheDocument();
  });

  it("Dismiss closes it for this lead; Send a template brings the list back", async () => {
    const { unmount } = render(<TemplatePick leadId="l1" leadName="Sneha Reddy" ai onSent={vi.fn()} />);
    await screen.findByRole("region", { name: "Recommended by LUME AI" });
    await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("region", { name: "Recommended by LUME AI" })).toBeNull();
    unmount();
    // Opened again in this session: still dismissed, and nothing is asked of LUME AI again.
    vi.mocked(whatsappClient.recommendTemplate).mockClear();
    render(<TemplatePick leadId="l1" leadName="Sneha Reddy" ai onSent={vi.fn()} />);
    await userEvent.click(await screen.findByRole("button", { name: "Send a template" }));
    expect(screen.getByRole("radio", { name: /Gentle nudge/ })).toBeInTheDocument();
    expect(whatsappClient.recommendTemplate).not.toHaveBeenCalled();
  });

  it("Other templates shows the rest to choose from, and back again", async () => {
    render(<TemplatePick leadId="l1" leadName="Sneha Reddy" ai onSent={vi.fn()} />);
    await userEvent.click(await screen.findByRole("button", { name: "Other templates" }));
    expect(screen.getByRole("radio", { name: /Visit reminder/ })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Back to LUME AI's pick" }));
    expect(screen.getByRole("region", { name: "Recommended by LUME AI" })).toBeInTheDocument();
  });

  it("no pick (LUME AI off, nothing fits, or an answer LUME can't use): the list, as before", async () => {
    vi.mocked(whatsappClient.recommendTemplate).mockResolvedValue(ok({ pick: null }));
    render(<TemplatePick leadId="l1" leadName="Sneha Reddy" ai onSent={vi.fn()} />);
    expect(await screen.findByRole("radio", { name: /Gentle nudge/ })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Recommended by LUME AI" })).toBeNull();
  });
});
