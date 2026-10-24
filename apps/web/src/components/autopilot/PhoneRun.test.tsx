import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { autopilotClient } from "@/lib/autopilot/client";
import type { RunDetail, RunLead, RunsList } from "@/lib/autopilot/types";
import { whatsappClient } from "@/lib/whatsapp/client";
import { AutopilotScreen } from "./AutopilotScreen";

vi.mock("@/lib/usePhone", () => ({ usePhone: () => true }));
vi.mock("@/lib/autopilot/client", () => ({
  autopilotClient: {
    run: vi.fn(),
    runs: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    takeOver: vi.fn(),
    carryOn: vi.fn(),
  },
}));
vi.mock("@/lib/whatsapp/client", async (orig) => ({
  ...(await orig<typeof import("@/lib/whatsapp/client")>()),
  whatsappClient: { thread: vi.fn(), templateState: vi.fn(), mediaInfo: vi.fn() },
}));
vi.mock("@/lib/notifications/stream", () => ({ useAutopilot: () => undefined }));
vi.mock("@/components/ZoneProvider", () => ({ useZone: () => "Asia/Kolkata" }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn(), push: vi.fn() }) }));
vi.mock("@/components/feedback/ToastProvider", () => ({
  useToast: () => ({ toast: vi.fn(), dismiss: vi.fn() }),
}));

const ok = <T,>(data: T) => ({ ok: true as const, status: 200, data });
const lead = (o: Partial<RunLead> & { leadId: string; name: string }): RunLead => ({
  state: "talking",
  reason: null,
  card: null,
  thought: null,
  repliedAt: "t",
  draft: null,
  nextAt: null,
  lastSentAt: "t",
  updatedAt: "2026-10-26T08:00:00.000Z",
  ...o,
});
const detail = {
  run: {
    id: "r1",
    name: "Office leads",
    status: "running",
    pauseReason: null,
    canControl: true,
    speakerName: "Priya Nair",
  },
  counts: {},
  leads: [
    lead({ leadId: "a", name: "Vikram Shetty" }),
    lead({
      leadId: "b",
      name: "Meera Iyer",
      state: "ready",
      card: { headline: "Reached Site visit booked", quote: "Saturday at 4" },
    }),
  ],
  asks: [],
} as unknown as RunDetail;
const runs = {
  runs: [{ id: "r1", name: "Office leads", status: "running" }],
  running: 1,
} as unknown as RunsList;

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(autopilotClient.run).mockResolvedValue(ok(detail));
  vi.mocked(autopilotClient.pause).mockResolvedValue(ok({ run: {} as never }));
  vi.mocked(whatsappClient.thread).mockResolvedValue(ok({ on: true, reply: null, messages: [] } as never));
});

/** Autopilot on a phone (spec 2026-10-19 §2.3): one lead at a time, Live or Ready, Pause always in reach. */
describe("Autopilot on a phone", () => {
  it("Live shows the lead LUME AI is on; Ready, with its count, shows the cards", async () => {
    render(<AutopilotScreen initial={runs} askedRun={null} canStart />);
    const show = await screen.findByRole("radiogroup", { name: "Show" });
    expect(screen.getByRole("region", { name: "Conversation with Vikram Shetty" })).toBeInTheDocument();
    await userEvent.click(within(show).getByRole("radio", { name: "Ready · 1" }));
    expect(screen.getByRole("article", { name: "Meera Iyer" })).toHaveTextContent(
      "Reached Site visit booked",
    );
    expect(screen.queryByRole("region", { name: /Conversation with/ })).toBeNull();
  });

  it("Pause is in reach on either tab", async () => {
    render(<AutopilotScreen initial={runs} askedRun={null} canStart />);
    await userEvent.click(await screen.findByRole("radio", { name: "Ready · 1" }));
    await userEvent.click(screen.getByRole("button", { name: "Pause (Esc)" }));
    expect(autopilotClient.pause).toHaveBeenCalledWith("r1");
  });

  it("every lead is a tap away, folded under the conversation", async () => {
    render(<AutopilotScreen initial={runs} askedRun={null} canStart />);
    await userEvent.click(await screen.findByText("All leads in this run"));
    expect(screen.getByRole("list", { name: "Leads in this run" })).toBeInTheDocument();
  });
});
