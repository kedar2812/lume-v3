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
let phone = false;
vi.mock("@/lib/usePhone", () => ({ usePhone: () => phone }));
// The first visit is its own (WaitingWork.test): here, only that it's what a page with no runs shows.
vi.mock("./WaitingWork", () => ({
  WaitingWork: ({ canStart }: { canStart: boolean }) => (
    <section aria-label="The work waiting">{canStart ? "can start" : "watching"}</section>
  ),
}));

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
  phone = false;
});

/** Autopilot, the page (spec 2026-10-19 §2): watch LUME AI work, pause with Esc, take over by clicking its message. */
describe("AutopilotScreen", () => {
  it("no runs yet: the work that's waiting, never a pitch (plan 2026-10-28, artboard 4)", () => {
    render(<AutopilotScreen initial={{ runs: [], running: 0 }} askedRun={null} canStart />);
    expect(screen.getByRole("region", { name: "The work waiting" })).toHaveTextContent("can start");
  });

  it("LUME AI off: the page says so, and an admin gets the way to switch it on (owner, 2026-10-27)", () => {
    const { unmount } = render(
      <AutopilotScreen
        initial={{ runs: [], running: 0 }}
        askedRun={null}
        canStart
        off={{ canSwitch: true }}
      />,
    );
    expect(screen.getByRole("heading", { name: "LUME AI is off" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Switch LUME AI on" })).toHaveAttribute(
      "href",
      "/settings/integrations",
    );
    expect(screen.getByRole("link", { name: "What LUME AI does" })).toHaveAttribute("href", "/settings/ai");
    // Its mark, grey and drawing slowly (artboard 5).
    expect(document.querySelector("[data-draw='loop'][data-tone='muted']")).not.toBeNull();
    expect(screen.queryByRole("region", { name: "The work waiting" })).toBeNull();
    unmount();
    render(
      <AutopilotScreen
        initial={{ runs: [], running: 0 }}
        askedRun={null}
        canStart
        off={{ canSwitch: false }}
      />,
    );
    expect(screen.getByText("An admin can switch it on in Settings → Integrations.")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Switch LUME AI on" })).toBeNull();
  });

  it("opens on the run going: where it stands in one line, and the lead LUME AI is writing to (plan 2026-10-28)", async () => {
    render(<AutopilotScreen initial={runs} askedRun={null} canStart />);
    expect(
      await screen.findByRole("heading", { name: "Site visit booked · 2 leads", level: 2 }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("LUME AI is following up with 2 leads · 2 messaged · 1 replied"),
    ).toBeInTheDocument();
    expect(await screen.findByText("LUME AI is writing as Priya Nair")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Conversation with Meera Iyer" })).toHaveTextContent(
      "Why · Only one approved template fits Meera, so LUME AI uses it.",
    );
    // Nobody needs anyone: it opens on everyone.
    expect(screen.getByRole("radio", { name: "All 2" })).toBeChecked();
  });

  it("opens on Needs you when someone needs you, with that lead shown", async () => {
    const rohan = lead({
      leadId: "b",
      name: "Rohan Gupta",
      state: "needs_you",
      reason: "Asked for a discount.",
    });
    vi.mocked(autopilotClient.run).mockResolvedValue(ok(detail({ leads: [writing, rohan] })));
    render(<AutopilotScreen initial={runs} askedRun={null} canStart />);
    expect(await screen.findByRole("radio", { name: "Needs you 1" })).toBeChecked();
    expect(screen.getByRole("region", { name: "Conversation with Rohan Gupta" })).toBeInTheDocument();
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

  it("choosing another lead shows theirs while LUME AI carries on; its own lead is one click back", async () => {
    render(<AutopilotScreen initial={runs} askedRun={null} canStart />);
    await userEvent.click(await screen.findByRole("button", { name: /^Rohan Gupta/ }));
    expect(screen.getByRole("region", { name: "Conversation with Rohan Gupta" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /LUME AI is on this lead/ }));
    expect(screen.getByRole("region", { name: "Conversation with Meera Iyer" })).toBeInTheDocument();
  });

  it("a phone: the list first; a lead opens its conversation, and Back returns to the list", async () => {
    phone = true;
    render(<AutopilotScreen initial={runs} askedRun={null} canStart />);
    await userEvent.click(await screen.findByRole("button", { name: /^Rohan Gupta/ }));
    expect(screen.getByRole("region", { name: "Conversation with Rohan Gupta" })).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Leads in this run" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Back to the leads" }));
    expect(screen.getByRole("list", { name: "Leads in this run" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: /Conversation with/ })).toBeNull();
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
    await userEvent.click(await screen.findByRole("radio", { name: "Ready 1" }));
    const pane = screen.getByRole("region", { name: "Conversation with Rohan Gupta" });
    await userEvent.click(await within(pane).findByRole("button", { name: "Let LUME AI carry on" }));
    expect(autopilotClient.carryOn).toHaveBeenCalledWith("r1", "b");
  });

  it("an ended run: its leads are simply yours to message, and LUME AI can't carry on", async () => {
    const rohan = lead({
      leadId: "b",
      name: "Rohan Gupta",
      state: "ready",
      reason: "Reached Site visit booked",
    });
    vi.mocked(autopilotClient.run).mockResolvedValue(ok(detail({ status: "ended", leads: [rohan] })));
    render(<AutopilotScreen initial={runs} askedRun={null} canStart />);
    const pane = await screen.findByRole("region", { name: "Conversation with Rohan Gupta" });
    expect(await within(pane).findByRole("textbox", { name: "Message to Rohan" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Let LUME AI carry on" })).toBeNull();
  });

  it("a lead that arrives needing you while you watch: LUME says so once, with Take over", async () => {
    render(<AutopilotScreen initial={runs} askedRun={null} canStart />);
    await screen.findByText("LUME AI is writing as Priya Nair");
    expect(toast).not.toHaveBeenCalled();
    const rohan = lead({
      leadId: "b",
      name: "Rohan Gupta",
      state: "needs_you",
      reason: "Asked for a discount.",
    });
    vi.mocked(autopilotClient.run).mockResolvedValue(ok(detail({ leads: [writing, rohan] })));
    await userEvent.keyboard("{Escape}"); // any refresh brings the new state; Pause reads the run again
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Rohan needs you: Asked for a discount." }),
      ),
    );
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
