import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { autopilotClient } from "@/lib/autopilot/client";
import type { RunDetail, RunLead, RunsList } from "@/lib/autopilot/types";
import { whatsappClient } from "@/lib/whatsapp/client";
import { AutopilotScreen, runToShow } from "./AutopilotScreen";

vi.mock("@/lib/autopilot/client", () => ({
  autopilotClient: {
    run: vi.fn(),
    runs: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    end: vi.fn(),
    takeOver: vi.fn(),
    handBack: vi.fn(),
    carryOn: vi.fn(),
    approve: vi.fn(),
    decline: vi.fn(),
  },
}));
vi.mock("@/lib/whatsapp/client", async (orig) => ({
  ...(await orig<typeof import("@/lib/whatsapp/client")>()),
  whatsappClient: { thread: vi.fn(), send: vi.fn(), templateState: vi.fn(), mediaInfo: vi.fn() },
}));
vi.mock("@/lib/notifications/stream", () => ({ useAutopilot: () => undefined }));
vi.mock("@/components/ZoneProvider", () => ({ useZone: () => "Asia/Kolkata" }));
const replace = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace, push: vi.fn() }) }));
const toast = vi.fn();
vi.mock("@/components/feedback/ToastProvider", () => ({ useToast: () => ({ toast, dismiss: vi.fn() }) }));

const ok = <T,>(data: T) => ({ ok: true as const, status: 200, data });
const lead = (o: Partial<RunLead> & { leadId: string; name: string }): RunLead => ({
  state: "sent",
  reason: null,
  card: null,
  thought: null,
  repliedAt: null,
  draft: null,
  nextAt: null,
  lastSentAt: "2026-10-26T08:00:00.000Z",
  updatedAt: "2026-10-26T08:00:00.000Z",
  ...o,
});
const now = Date.now();
const writing = lead({
  leadId: "a",
  name: "Meera Iyer",
  state: "writing",
  thought: "Only one approved template fits Meera, so LUME AI uses it.",
  draft: {
    text: "Hi Meera, thanks for your enquiry.",
    kind: "template",
    templateName: "First hello",
    startedAt: new Date(now - 60_000).toISOString(),
    revealedBy: new Date(now + 60_000).toISOString(),
    marks: [[3, 8]],
  },
});
const detail = (
  o: { status?: "running" | "paused" | "ended"; canControl?: boolean; leads?: RunLead[] } = {},
): RunDetail =>
  ({
    run: {
      id: "r1",
      name: "Site visit booked · 2 leads",
      status: o.status ?? "running",
      pauseReason: o.status === "paused" ? "person" : null,
      canControl: o.canControl ?? true,
      speakerName: "Priya Nair",
    },
    counts: {},
    leads: o.leads ?? [writing, lead({ leadId: "b", name: "Rohan Gupta", state: "talking", repliedAt: "x" })],
    asks: [],
  }) as unknown as RunDetail;
const runs: RunsList = {
  runs: [{ id: "r1", name: "Site visit booked · 2 leads", status: "running" } as RunsList["runs"][number]],
  running: 1,
};
const thread = {
  on: true,
  reply: {
    allowed: true,
    number: { id: "n1", display: "+91 90000 00001", ownerName: null },
    until: null,
    reason: null,
  },
  messages: [],
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(autopilotClient.run).mockResolvedValue(ok(detail()));
  vi.mocked(autopilotClient.pause).mockResolvedValue(ok({ run: {} as never }));
  vi.mocked(autopilotClient.resume).mockResolvedValue(ok({ run: {} as never }));
  vi.mocked(whatsappClient.thread).mockResolvedValue(ok(thread as never));
  vi.mocked(whatsappClient.templateState).mockResolvedValue(ok(null));
});

/** Autopilot, the page (spec 2026-10-19 §2): watch LUME AI work, pause with Esc, take over by clicking its message. */
describe("AutopilotScreen", () => {
  it("no runs yet: what Autopilot does, in three lines, and where to start", () => {
    render(<AutopilotScreen initial={{ runs: [], running: 0 }} askedRun={null} canStart />);
    expect(screen.getByRole("heading", { name: "Let LUME AI work your leads" })).toBeInTheDocument();
    expect(screen.getByText(/Select leads on Leads/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Choose leads" })).toHaveAttribute("href", "/leads");
  });

  it("opens on the run going, and says what LUME AI is doing to whom", async () => {
    render(<AutopilotScreen initial={runs} askedRun={null} canStart />);
    expect(await screen.findByRole("region", { name: "Site visit booked · 2 leads" })).toHaveTextContent(
      "LUME AI is working",
    );
    expect(await screen.findByText("LUME AI is writing as Priya Nair")).toBeInTheDocument();
    expect(
      screen.getByText("Only one approved template fits Meera, so LUME AI uses it."),
    ).toBeInTheDocument();
  });

  it("Esc pauses everything; Esc again resumes; never while typing in a box", async () => {
    render(<AutopilotScreen initial={runs} askedRun={null} canStart />);
    await screen.findByText("LUME AI is writing as Priya Nair");
    // Typing in a box, Esc is that box's: nothing is paused.
    const box = document.createElement("textarea");
    document.body.appendChild(box);
    box.focus();
    await userEvent.keyboard("{Escape}");
    expect(autopilotClient.pause).not.toHaveBeenCalled();
    box.remove();
    // What the server says once it's paused: the read after Pause brings it.
    vi.mocked(autopilotClient.run).mockResolvedValue(ok(detail({ status: "paused" })));
    await userEvent.keyboard("{Escape}");
    expect(autopilotClient.pause).toHaveBeenCalledWith("r1");
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Paused"));
    await userEvent.keyboard("{Escape}");
    expect(autopilotClient.resume).toHaveBeenCalledWith("r1");
  });

  it("a Pause that didn't reach LUME doesn't leave the typing frozen, and says so", async () => {
    vi.mocked(autopilotClient.pause).mockResolvedValue({
      ok: false,
      status: 0,
      code: "OFFLINE",
      message: "LUME can’t reach the server right now.",
    });
    render(<AutopilotScreen initial={runs} askedRun={null} canStart />);
    await screen.findByText("LUME AI is writing as Priya Nair");
    await userEvent.keyboard("{Escape}");
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: "LUME couldn't pause it" })),
    );
    // Still running, so still typing: not a frozen box.
    await waitFor(() => expect(document.querySelector("[data-frozen]")).toBeNull());
  });

  it("someone who can't control the run: Esc does nothing", async () => {
    vi.mocked(autopilotClient.run).mockResolvedValue(ok(detail({ canControl: false })));
    render(<AutopilotScreen initial={runs} askedRun={null} canStart={false} />);
    await screen.findByText("LUME AI is writing as Priya Nair");
    await userEvent.keyboard("{Escape}");
    expect(autopilotClient.pause).not.toHaveBeenCalled();
  });

  it("clicking LUME AI's message takes the lead over: the half-typed words are yours", async () => {
    vi.mocked(autopilotClient.takeOver).mockResolvedValue(
      ok({ leadId: "a", state: "with_you", draft: "Hi Meera, thanks for your enquiry." }),
    );
    render(<AutopilotScreen initial={runs} askedRun={null} canStart />);
    await userEvent.click(
      await screen.findByRole("button", { name: "Take over Meera: type your own message" }),
    );
    expect(autopilotClient.takeOver).toHaveBeenCalledWith("r1", "a");
  });

  it("watching another lead while LUME AI carries on; back to its lead", async () => {
    render(<AutopilotScreen initial={runs} askedRun={null} canStart />);
    await userEvent.click(await screen.findByRole("button", { name: /Rohan Gupta/ }));
    expect(screen.getByRole("region", { name: "Conversation with Rohan Gupta" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Back to LUME AI's lead" }));
    expect(screen.getByRole("region", { name: "Conversation with Meera Iyer" })).toBeInTheDocument();
  });

  it("a lead ready for you, watched: carry on from the conversation itself", async () => {
    const rohan = lead({
      leadId: "b",
      name: "Rohan Gupta",
      state: "ready",
      reason: "Reached Site visit booked",
    });
    vi.mocked(autopilotClient.run).mockResolvedValue(ok(detail({ leads: [writing, rohan] })));
    vi.mocked(autopilotClient.carryOn).mockResolvedValue(ok({ leadId: "b", state: "sent" }) as never);
    render(<AutopilotScreen initial={runs} askedRun={null} canStart />);
    await userEvent.click(await screen.findByRole("button", { name: /Rohan Gupta/ }));
    const pane = screen.getByRole("region", { name: "Conversation with Rohan Gupta" });
    await userEvent.click(await within(pane).findByRole("button", { name: "Let LUME AI carry on" }));
    expect(autopilotClient.carryOn).toHaveBeenCalledWith("r1", "b");
  });

  it("an ended run: its ready leads can be taken, but LUME AI can't carry on", async () => {
    const rohan = lead({
      leadId: "b",
      name: "Rohan Gupta",
      state: "ready",
      reason: "Reached Site visit booked",
    });
    vi.mocked(autopilotClient.run).mockResolvedValue(ok(detail({ status: "ended", leads: [rohan] })));
    render(<AutopilotScreen initial={runs} askedRun={null} canStart />);
    const card = await screen.findByRole("article", { name: "Rohan Gupta" });
    expect(within(card).getByRole("button", { name: "Take over" })).toBeInTheDocument();
    expect(within(card).queryByRole("button", { name: "Let LUME AI carry on" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Let LUME AI carry on" })).toBeNull();
  });
});

describe("runToShow", () => {
  const list = [
    { id: "old", status: "ended" },
    { id: "going", status: "running" },
  ] as RunsList["runs"];
  it("the one asked for, else the one going, else the newest", () => {
    expect(runToShow(list, "old")).toBe("old");
    expect(runToShow(list, "missing")).toBe("going");
    expect(runToShow([list[0]!], null)).toBe("old");
    expect(runToShow([], null)).toBeNull();
  });
});
