import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { whatsappClient } from "@/lib/whatsapp/client";
import type { WaNumber } from "@/lib/whatsapp/types";
import { WhatsAppCard } from "./WhatsAppCard";

vi.mock("@/lib/whatsapp/client", () => ({
  whatsappClient: {
    setEnabled: vi.fn(),
    connect: vi.fn(),
    numbers: vi.fn(),
    setOwner: vi.fn(),
    disconnect: vi.fn(),
    people: vi.fn(),
  },
}));
const ok = <T,>(data: T) => ({ ok: true as const, status: 200, data });
const number = (over: Partial<WaNumber> = {}): WaNumber => ({
  id: "n1",
  display: "+91 90000 00001",
  name: "Harbour Studio",
  owner: null,
  status: "active",
  problem: null,
  historyShared: true,
  connectedAt: "2026-10-18T10:00:00.000Z",
  ...over,
});
const on = { enabled: true, available: true, inPlan: true };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(whatsappClient.numbers).mockResolvedValue(ok({ numbers: [] }));
  vi.mocked(whatsappClient.people).mockResolvedValue(
    ok({
      people: [
        { id: "u1", name: "Anusha Rao", active: true },
        { id: "u2", name: "Left Already", active: false },
      ],
    }),
  );
});

describe("the WhatsApp card (spec 2026-10-18 §3.2; canvas board Main)", () => {
  it("off by default: one switch, what it does, and what LUME keeps", () => {
    render(<WhatsAppCard wa={{ enabled: false, available: true, inPlan: true }} onView={vi.fn()} />);
    expect(screen.getByRole("heading", { name: "WhatsApp" })).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "WhatsApp" })).not.toBeChecked();
    expect(screen.getByText(/LUME keeps chats with your leads only/)).toBeInTheDocument();
    expect(whatsappClient.numbers).not.toHaveBeenCalled();
  });

  it("not in the plan: the pill, and no switch to flip", () => {
    render(<WhatsAppCard wa={{ enabled: false, available: true, inPlan: false }} onView={vi.fn()} />);
    expect(screen.getByText("Not in this LUME’s plan")).toBeInTheDocument();
    expect(screen.getByRole("switch")).toBeDisabled();
  });

  it("while its numbers load, a placeholder holds the card's place: it never collapses and jumps back (owner, 2026-10-27)", async () => {
    let answer: (v: unknown) => void = () => {};
    vi.mocked(whatsappClient.numbers).mockReturnValue(new Promise((r) => (answer = r)) as never);
    render(<WhatsAppCard wa={on} onView={vi.fn()} />);
    const holding = screen.getByRole("status", { name: "Looking for connected numbers" });
    expect(holding).toHaveAttribute("aria-busy", "true");
    answer(ok({ numbers: [] }));
    expect(await screen.findByText("No number connected yet.")).toBeInTheDocument();
    expect(screen.queryByRole("status", { name: "Looking for connected numbers" })).toBeNull();
  });

  it("switching on says so to the page", async () => {
    const onView = vi.fn();
    vi.mocked(whatsappClient.setEnabled).mockResolvedValue(ok({ whatsapp: on } as never));
    render(<WhatsAppCard wa={{ enabled: false, available: true, inPlan: true }} onView={onView} />);
    await userEvent.click(screen.getByRole("switch", { name: "WhatsApp" }));
    expect(whatsappClient.setEnabled).toHaveBeenCalledWith(true);
    expect(onView).toHaveBeenCalled();
  });

  it("on, no number: Connect shows what changes on the phone before anything happens; Continue goes to Meta", async () => {
    vi.mocked(whatsappClient.connect).mockResolvedValue(ok({ url: "https://relay.test/wa/start?x" }));
    const assign = vi.fn();
    Object.defineProperty(window, "location", { value: { ...window.location, assign }, writable: true });
    render(<WhatsAppCard wa={on} onView={vi.fn()} />);
    await userEvent.click(await screen.findByRole("button", { name: "Connect a WhatsApp number" }));
    const sheet = screen.getByRole("dialog", { name: "Connect a WhatsApp number" });
    // Each change at a glance: an icon, what stops, and what to do instead (owner, 2026-10-27).
    const changes = within(sheet).getByRole("list", { name: "What changes on the phone" });
    expect(
      within(changes)
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual([
      "Broadcast lists stopThey stop working in the WhatsApp Business app.",
      "WhatsApp for Windows stopsUse WhatsApp Web on a computer instead.",
      "Open WhatsApp every 13 daysOn the phone, or the connection pauses.",
    ]);
    expect(whatsappClient.connect).not.toHaveBeenCalled();
    await userEvent.click(within(sheet).getByRole("button", { name: "Continue with Facebook" }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith("https://relay.test/wa/start?x"));
  });

  it("each number: whose it is (a person, or the business), changed in place", async () => {
    vi.mocked(whatsappClient.numbers).mockResolvedValue(ok({ numbers: [number()] }));
    vi.mocked(whatsappClient.setOwner).mockResolvedValue(
      ok({ numbers: [number({ owner: { id: "u1", name: "Anusha Rao" } })] }),
    );
    render(<WhatsAppCard wa={on} onView={vi.fn()} />);
    const whose = await screen.findByRole("combobox", { name: "Whose number is +91 90000 00001?" });
    expect(whose).toHaveValue("");
    // Only people who use LUME now.
    expect(
      within(whose)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["The business", "Anusha Rao"]);
    await userEvent.selectOptions(whose, "u1");
    expect(whatsappClient.setOwner).toHaveBeenCalledWith("n1", "u1");
    expect(await screen.findByRole("combobox", { name: "Whose number is +91 90000 00001?" })).toHaveValue(
      "u1",
    );
  });

  it("a number that needs attention says why in words, and offers to connect it again", async () => {
    vi.mocked(whatsappClient.numbers).mockResolvedValue(
      ok({
        numbers: [
          number({
            status: "needs_attention",
            problem: "WhatsApp stopped letting LUME in. Connect this number again.",
          }),
        ],
      }),
    );
    render(<WhatsAppCard wa={on} onView={vi.fn()} />);
    expect(
      await screen.findByText("WhatsApp stopped letting LUME in. Connect this number again."),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Connect again" }));
    expect(screen.getByRole("dialog", { name: "Connect a WhatsApp number" })).toBeInTheDocument();
  });

  it("Disconnect asks first, then disconnects", async () => {
    vi.mocked(whatsappClient.numbers).mockResolvedValue(ok({ numbers: [number()] }));
    vi.mocked(whatsappClient.disconnect).mockResolvedValue(ok({ numbers: [] }));
    render(<WhatsAppCard wa={on} onView={vi.fn()} />);
    await userEvent.click(await screen.findByRole("button", { name: "Disconnect +91 90000 00001" }));
    const ask = screen.getByRole("dialog", { name: "Disconnect +91 90000 00001?" });
    expect(within(ask).getByText(/What’s already on leads stays/)).toBeInTheDocument();
    await userEvent.click(within(ask).getByRole("button", { name: "Disconnect" }));
    expect(whatsappClient.disconnect).toHaveBeenCalledWith("n1");
    expect(await screen.findByText("No number connected yet.")).toBeInTheDocument();
  });
});
