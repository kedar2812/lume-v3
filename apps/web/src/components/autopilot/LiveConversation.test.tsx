import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AutopilotEvent } from "@/lib/notifications/stream";
import type { RunLead } from "@/lib/autopilot/types";
import type { WaThread } from "@/lib/whatsapp/types";
import { whatsappClient } from "@/lib/whatsapp/client";
import { LiveConversation } from "./LiveConversation";

vi.mock("@/lib/whatsapp/client", async (orig) => ({
  ...(await orig<typeof import("@/lib/whatsapp/client")>()),
  whatsappClient: { thread: vi.fn(), send: vi.fn(), templateState: vi.fn(), mediaInfo: vi.fn() },
}));
let hear: ((e: AutopilotEvent) => void) | null = null;
vi.mock("@/lib/notifications/stream", () => ({
  useAutopilot: (on: (e: AutopilotEvent) => void) => {
    hear = on;
  },
}));
const ok = <T,>(data: T) => ({ ok: true as const, status: 200, data });
const thread = (o: Partial<WaThread> = {}): WaThread => ({
  on: true,
  reply: {
    allowed: true,
    number: { id: "n1", display: "+91 90000 00001", ownerName: null },
    until: "2026-10-26T20:00:00.000Z",
    reason: null,
  },
  messages: [
    {
      id: "m1",
      direction: "in",
      at: "2026-10-26T08:00:00.000Z",
      text: "Do you do kitchens?",
      media: null,
      sentBy: null,
      status: null,
      problem: null,
      outboxId: null,
      lumeAi: null,
    },
  ],
  ...o,
});
const lead = (o: Partial<RunLead> = {}): RunLead => ({
  leadId: "a",
  name: "Meera Iyer",
  state: "talking",
  reason: null,
  card: null,
  thought: null,
  repliedAt: "2026-10-26T08:00:00.000Z",
  draft: null,
  nextAt: null,
  lastSentAt: null,
  updatedAt: "2026-10-26T08:00:00.000Z",
  ...o,
});
const props = (o: Partial<Parameters<typeof LiveConversation>[0]> = {}) => ({
  lead: lead(),
  current: true,
  tz: "Asia/Kolkata",
  speaker: "Priya Nair",
  frozenAt: null,
  takenOverText: null,
  onBack: vi.fn(),
  onTakeOver: vi.fn(),
  onHandBack: vi.fn(),
  ended: false,
  canDecide: true,
  onCarryOn: vi.fn(),
  ...o,
});

beforeEach(() => {
  vi.resetAllMocks();
  hear = null;
  vi.mocked(whatsappClient.thread).mockResolvedValue(ok(thread()));
  vi.mocked(whatsappClient.templateState).mockResolvedValue(ok(null));
});

/** The live conversation (Autopilot spec 2026-10-19 §2): the thread, what LUME AI is thinking, and its typing. */
describe("LiveConversation", () => {
  it("the lead's thread, and LUME AI's thought in its own words", async () => {
    render(
      <LiveConversation
        {...props({ lead: lead({ state: "writing", thought: "She asked about kitchens." }) })}
      />,
    );
    expect(await screen.findByText("Do you do kitchens?")).toBeInTheDocument();
    expect(screen.getByText("She asked about kitchens.")).toBeInTheDocument();
  });

  it("reads the thread again when LUME AI sends to this lead, not for others", async () => {
    render(<LiveConversation {...props()} />);
    await waitFor(() => expect(whatsappClient.thread).toHaveBeenCalledTimes(1));
    hear!({ run: "r1", lead: "other", kind: "sent" });
    hear!({ run: "r1", lead: "a", kind: "sent" });
    await waitFor(() => expect(whatsappClient.thread).toHaveBeenCalledTimes(2));
  });

  it("watching another lead: Back to LUME AI's lead", async () => {
    const p = props({ current: false });
    render(<LiveConversation {...p} />);
    await userEvent.click(await screen.findByRole("button", { name: "Back to LUME AI's lead" }));
    expect(p.onBack).toHaveBeenCalledOnce();
  });

  it("a lead with you: your own reply box, starting from LUME AI's words, and Hand back", async () => {
    const p = props({ lead: lead({ state: "with_you" }), takenOverText: "Yes, we design" });
    render(<LiveConversation {...p} />);
    expect(await screen.findByRole("textbox", { name: "Message to Meera" })).toHaveValue("Yes, we design");
    await userEvent.click(screen.getByRole("button", { name: "Hand back to LUME AI" }));
    expect(p.onHandBack).toHaveBeenCalledOnce();
  });

  it("a lead LUME AI is working, not typing now: Take over is one click", async () => {
    const p = props();
    render(<LiveConversation {...p} />);
    await userEvent.click(await screen.findByRole("button", { name: "Take over Meera" }));
    expect(p.onTakeOver).toHaveBeenCalledOnce();
  });

  it("someone who can't message this lead watches only: no Take over, no reply box", async () => {
    vi.mocked(whatsappClient.thread).mockResolvedValue(ok(thread({ reply: null })));
    render(<LiveConversation {...props()} />);
    await screen.findByText("Do you do kitchens?");
    expect(screen.queryByRole("button", { name: /Take over/ })).toBeNull();
  });

  it("a lead ready for you, or needing you: Take over, or let LUME AI carry on, right here", async () => {
    const p = props({ lead: lead({ state: "ready", reason: "Reached Site visit booked" }) });
    const { unmount } = render(<LiveConversation {...p} />);
    expect(await screen.findByText("Meera is ready for you.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Take over Meera" }));
    expect(p.onTakeOver).toHaveBeenCalledOnce();
    await userEvent.click(screen.getByRole("button", { name: "Let LUME AI carry on" }));
    expect(p.onCarryOn).toHaveBeenCalledOnce();
    unmount();

    const q = props({
      lead: lead({ state: "needs_you", reason: "Asked about a discount." }),
      canDecide: false,
    });
    render(<LiveConversation {...q} />);
    expect(await screen.findByText("Meera needs you.")).toBeInTheDocument();
    expect(screen.getByText("Asked about a discount.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Take over Meera" }));
    expect(q.onTakeOver).toHaveBeenCalledOnce();
    // Carrying on is the run's controllers' call; anyone who may message the lead may take it.
    expect(screen.queryByRole("button", { name: "Let LUME AI carry on" })).toBeNull();
  });

  it("ready for you, but this person can't message the lead: nothing to take", async () => {
    vi.mocked(whatsappClient.thread).mockResolvedValue(ok(thread({ reply: null })));
    render(<LiveConversation {...props({ lead: lead({ state: "ready" }) })} />);
    await screen.findByText("Do you do kitchens?");
    expect(screen.queryByRole("button", { name: /Take over/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Let LUME AI carry on" })).toBeNull();
  });

  it("a run that has ended: nobody's working the lead, so it's simply yours to message", async () => {
    const p = props({
      ended: true,
      lead: lead({ state: "talking", thought: "Meera asked about kitchens." }),
    });
    render(<LiveConversation {...p} />);
    expect(await screen.findByRole("textbox", { name: "Message to Meera" })).toBeInTheDocument();
    expect(screen.queryByText("LUME AI is working this conversation for you.")).toBeNull();
    expect(screen.queryByText("Meera asked about kitchens.")).toBeNull();
    expect(screen.queryByRole("button", { name: /Take over/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Hand back to LUME AI" })).toBeNull();
  });
});
