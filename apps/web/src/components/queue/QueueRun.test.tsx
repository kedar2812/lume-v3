import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { queuesClient, type QueueItemStatus, type QueueView } from "@/lib/queues/client";
import { QueueRun } from "./QueueRun";

vi.mock("@/lib/queues/client", async (orig) => ({
  ...(await orig<typeof import("@/lib/queues/client")>()),
  queuesClient: {
    get: vi.fn(),
    text: vi.fn(),
    prepare: vi.fn(),
    sent: vi.fn(),
    notSent: vi.fn(),
    skip: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    cancel: vi.fn(),
  },
}));
const play = vi.fn();
vi.mock("@/components/feedback/SoundProvider", () => ({ useSound: () => ({ play }) }));
const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, replace: vi.fn(), back: vi.fn() }) }));
let reduce = false;
vi.mock("motion/react", async (orig) => ({
  ...(await orig<typeof import("motion/react")>()),
  useReducedMotion: () => reduce,
}));

const ok = <T,>(data: T) => ({ ok: true as const, status: 200, data });
const NAMES = ["Aisha Khan", "Bea Lopez", "Chen Wei"];
let q: QueueView;
const counts = () => {
  const n = (st: QueueItemStatus) => q.items.filter((i) => i.status === st).length;
  q.done = { sent: n("sent"), notSent: n("not_sent"), skipped: n("skipped") };
};
function settle(pos: number, status: QueueItemStatus, reason: string | null = null) {
  q.items[pos]!.status = status;
  q.items[pos]!.reason = reason;
  counts();
  const next = q.items.find((i) => i.status === "pending")?.position ?? null;
  if (next === null && !q.items.some((i) => i.status === "sending")) {
    q.status = "finished";
    return ok({ next: null, finished: true as const });
  }
  return ok({ next });
}
const tab = () => {
  const w = { location: { href: "" }, close: vi.fn(), opener: {} as unknown };
  vi.spyOn(window, "open").mockReturnValue(w as unknown as Window);
  return w;
};

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  reduce = false;
  q = {
    id: "q1",
    status: "active",
    pausedReason: null,
    templateName: "Gentle nudge",
    sourceName: "No reply 3+ days",
    total: 3,
    done: { sent: 0, notSent: 0, skipped: 0 },
    today: { sent: 37, cap: 150 },
    items: NAMES.map((name, position) => ({
      position,
      leadId: `l${position}`,
      name,
      stageName: "Contacted",
      status: "pending" as QueueItemStatus,
      reason: null,
    })),
  };
  vi.mocked(queuesClient.get).mockImplementation(async () => ok(structuredClone(q)));
  vi.mocked(queuesClient.text).mockImplementation(async (_id, pos) =>
    ok({ text: `Hi ${NAMES[pos]!.split(" ")[0]}, just checking in.`, missing: [] }),
  );
  vi.mocked(queuesClient.prepare).mockImplementation(async (_id, pos, text) => {
    q.items[pos]!.status = "sending";
    return ok({ url: "https://wa.me/971500000000?text=hi", text: text ?? "Hi" });
  });
  vi.mocked(queuesClient.sent).mockImplementation(async (_id, pos) => settle(pos, "sent"));
  vi.mocked(queuesClient.notSent).mockImplementation(async (_id, pos) => settle(pos, "not_sent"));
  vi.mocked(queuesClient.skip).mockImplementation(async (_id, pos) => settle(pos, "skipped", "Skipped"));
  vi.mocked(queuesClient.pause).mockImplementation(async () => {
    q.status = "paused";
    return ok(structuredClone(q));
  });
  vi.mocked(queuesClient.cancel).mockImplementation(async () => {
    q.status = "cancelled";
    for (const i of q.items) if (i.status === "sending") i.status = "not_sent";
    counts();
    return ok(structuredClone(q));
  });
  vi.mocked(queuesClient.resume).mockImplementation(async () => {
    q.status = "active";
    return ok(structuredClone(q));
  });
});

const lead = (name: string) => screen.findByRole("heading", { name });
const back = () => act(async () => void window.dispatchEvent(new Event("focus")));

describe("QueueRun (4C Task 4)", () => {
  it("one lead at a time: Send opens WhatsApp, Sent? Yes, and the next lead comes", async () => {
    const w = tab();
    render(<QueueRun id="q1" />);
    await lead("Aisha Khan");
    expect(screen.getByText("No reply 3+ days")).toBeInTheDocument();
    expect(screen.getByText("0 of 3")).toBeInTheDocument();
    expect(screen.getByText("37 / 150")).toBeInTheDocument();
    expect(await screen.findByDisplayValue("Hi Aisha, just checking in.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Send" }));
    // Unchanged words: the server sends the version the run planned with.
    expect(queuesClient.prepare).toHaveBeenCalledWith("q1", 0, undefined);
    expect(w.location.href).toBe("https://wa.me/971500000000?text=hi");
    await back();
    const ask = await screen.findByRole("group", { name: "Was the WhatsApp message sent?" });
    await userEvent.click(within(ask).getByRole("button", { name: "Yes, sent" }));
    expect(queuesClient.sent).toHaveBeenCalledWith("q1", 0);
    expect(play).toHaveBeenCalledWith("sent");
    expect(await lead("Bea Lopez")).toBeInTheDocument();
    expect(await screen.findByText("1 of 3")).toBeInTheDocument();
  });

  it("by keyboard: Enter sends, N says not sent, S skips — skipping is silent", async () => {
    tab();
    render(<QueueRun id="q1" />);
    await lead("Aisha Khan");
    await screen.findByDisplayValue("Hi Aisha, just checking in.");
    await userEvent.keyboard("{Enter}");
    expect(queuesClient.prepare).toHaveBeenCalledWith("q1", 0, undefined);
    await back();
    await screen.findByRole("group", { name: "Was the WhatsApp message sent?" });
    await userEvent.keyboard("n");
    expect(queuesClient.notSent).toHaveBeenCalledWith("q1", 0);
    await lead("Bea Lopez");
    await userEvent.keyboard("s");
    expect(queuesClient.skip).toHaveBeenCalledWith("q1", 1);
    await lead("Chen Wei");
    expect(play).not.toHaveBeenCalled();
  });

  it("your own words for this one lead", async () => {
    tab();
    render(<QueueRun id="q1" />);
    const box = await screen.findByDisplayValue("Hi Aisha, just checking in.");
    await userEvent.clear(box);
    await userEvent.type(box, "Just for you");
    await userEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(queuesClient.prepare).toHaveBeenCalledWith("q1", 0, "Just for you");
  });

  it("a lead that can't be sent any more says why, and the run moves on", async () => {
    const w = tab();
    vi.mocked(queuesClient.prepare).mockImplementationOnce(async () => {
      settle(0, "skipped", "No WhatsApp number");
      return ok({ skipped: "No WhatsApp number", next: 1 });
    });
    render(<QueueRun id="q1" />);
    await screen.findByDisplayValue("Hi Aisha, just checking in.");
    await userEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(w.close).toHaveBeenCalled();
    expect(await screen.findByText("No WhatsApp number")).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "Bea Lopez" }, { timeout: 3000 })).toBeInTheDocument();
  });

  it("a lead that can't be sent before Send says why, and Skip is the way on (Enter too)", async () => {
    vi.mocked(queuesClient.text).mockResolvedValueOnce(ok({ unavailable: "No WhatsApp number" }));
    render(<QueueRun id="q1" />);
    await lead("Aisha Khan");
    expect(await screen.findByText("No WhatsApp number")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Send" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Skip" })).toHaveAttribute("data-variant", "primary");
    // Nothing to write for a lead that can't be sent: no message box.
    expect(screen.queryByRole("textbox", { name: "Message" })).not.toBeInTheDocument();
    await userEvent.keyboard("{Enter}");
    expect(queuesClient.skip).toHaveBeenCalledWith("q1", 0);
    expect(queuesClient.prepare).not.toHaveBeenCalled();
    await lead("Bea Lopez");
  });

  it("the daily cap pauses the run, in LUME's words", async () => {
    const w = tab();
    const words = "You've sent today's 150; the run is paused until tomorrow";
    vi.mocked(queuesClient.prepare).mockImplementationOnce(async () => {
      q.status = "paused";
      q.pausedReason = "daily_cap";
      return { ok: false as const, status: 409, code: "DAILY_CAP", message: words };
    });
    render(<QueueRun id="q1" />);
    await screen.findByDisplayValue("Hi Aisha, just checking in.");
    await userEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(w.close).toHaveBeenCalled();
    expect(await screen.findByText(words)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Resume" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Send" })).not.toBeInTheDocument();
  });

  it("P pauses and Resume picks up where it was; Esc leaves it paused", async () => {
    render(<QueueRun id="q1" />);
    await screen.findByDisplayValue("Hi Aisha, just checking in.");
    await userEvent.keyboard("p");
    expect(queuesClient.pause).toHaveBeenCalledWith("q1");
    expect(await screen.findByText("Paused")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Resume" }));
    expect(queuesClient.resume).toHaveBeenCalledWith("q1");
    await lead("Aisha Khan");
    await userEvent.keyboard("{Escape}");
    expect(queuesClient.pause).toHaveBeenCalledTimes(2);
    expect(push).toHaveBeenCalledWith("/today");
  });

  it("back after a reload mid-send: Sent? first", async () => {
    q.items[0]!.status = "sending";
    // This tab opened WhatsApp for it before the reload.
    sessionStorage.setItem("lume.queue.q1.claimed", "[0]");
    render(<QueueRun id="q1" />);
    expect(await screen.findByRole("group", { name: "Was the WhatsApp message sent?" })).toBeInTheDocument();
    expect(queuesClient.prepare).not.toHaveBeenCalled();
  });

  it("the end: cleared, and a summary with who was skipped and why", async () => {
    tab();
    q.items[0]!.status = "sent";
    q.items[1]!.status = "skipped";
    q.items[1]!.reason = "No WhatsApp number";
    counts();
    render(<QueueRun id="q1" />);
    await lead("Chen Wei");
    await screen.findByDisplayValue("Hi Chen, just checking in.");
    await userEvent.click(screen.getByRole("button", { name: "Send" }));
    await back();
    await userEvent.click(await screen.findByRole("button", { name: "Yes, sent" }));
    const summary = await screen.findByRole("region", { name: "Run finished" });
    expect(play).toHaveBeenLastCalledWith("cleared");
    expect(summary).toHaveTextContent("2 sent");
    expect(summary).toHaveTextContent("1 skipped");
    expect(within(summary).getByRole("list", { name: "Skipped" })).toHaveTextContent(
      "Bea LopezNo WhatsApp number",
    );
    await userEvent.click(within(summary).getByRole("button", { name: "Done" }));
    expect(push).toHaveBeenCalledWith("/today");
  });

  it("the card sliding out can't be pressed while the next comes in", async () => {
    tab();
    render(<QueueRun id="q1" />);
    await screen.findByDisplayValue("Hi Aisha, just checking in.");
    await userEvent.keyboard("s");
    await lead("Bea Lopez");
    // Whatever is still leaving is inert; only the new card answers to Send.
    expect(screen.getAllByRole("button", { name: "Send" })).toHaveLength(1);
  });

  it("final review #1: a lead another tab has open — this tab moves on, and never asks Sent? for it", async () => {
    const w = tab();
    vi.mocked(queuesClient.prepare).mockImplementationOnce(async () => {
      q.items[0]!.status = "sending"; // the other tab's
      return {
        ok: false as const,
        status: 409,
        code: "ITEM_TAKEN",
        message: "That lead is open in another tab",
        details: { next: 1 },
      };
    });
    render(<QueueRun id="q1" />);
    await screen.findByDisplayValue("Hi Aisha, just checking in.");
    await userEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(w.close).toHaveBeenCalled();
    expect(await screen.findByRole("heading", { name: "Bea Lopez" }, { timeout: 3000 })).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Was the WhatsApp message sent?" })).not.toBeInTheDocument();
  });

  it("a lead left open elsewhere is asked about once nothing else is left", async () => {
    q.items[0]!.status = "sending";
    q.items[1]!.status = "sent";
    q.items[2]!.status = "sent";
    counts();
    render(<QueueRun id="q1" />);
    await lead("Aisha Khan");
    expect(await screen.findByRole("group", { name: "Was the WhatsApp message sent?" })).toBeInTheDocument();
  });

  it("final review #2: End run, after a word to confirm, ends it here", async () => {
    render(<QueueRun id="q1" />);
    await lead("Aisha Khan");
    await userEvent.click(screen.getByRole("button", { name: "End run" }));
    const ask = screen.getByRole("group", { name: "End this run?" });
    await userEvent.click(within(ask).getByRole("button", { name: "Keep going" }));
    expect(queuesClient.cancel).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "End run" }));
    await userEvent.click(
      within(screen.getByRole("group", { name: "End this run?" })).getByRole("button", { name: "End it" }),
    );
    expect(queuesClient.cancel).toHaveBeenCalledWith("q1");
    expect(await screen.findByRole("region", { name: "Run ended" })).toBeInTheDocument();
  });

  it("final review #2: a run the daily cap paused can be ended too", async () => {
    q.status = "paused";
    q.pausedReason = "daily_cap";
    render(<QueueRun id="q1" />);
    await screen.findByText("Paused");
    await userEvent.click(screen.getByRole("button", { name: "End run" }));
    await userEvent.click(
      within(screen.getByRole("group", { name: "End this run?" })).getByRole("button", { name: "End it" }),
    );
    expect(queuesClient.cancel).toHaveBeenCalledWith("q1");
  });

  it("final review #5: keys pressed outside the run don't reach it; Esc in the message box only leaves the box", async () => {
    render(
      <>
        <div tabIndex={0} data-testid="outside">
          elsewhere
        </div>
        <QueueRun id="q1" />
      </>,
    );
    const box = await screen.findByDisplayValue("Hi Aisha, just checking in.");
    screen.getByTestId("outside").focus();
    await userEvent.keyboard("{Enter}");
    await userEvent.keyboard("s");
    expect(queuesClient.prepare).not.toHaveBeenCalled();
    expect(queuesClient.skip).not.toHaveBeenCalled();
    await userEvent.click(box);
    await userEvent.keyboard("{Escape}");
    expect(push).not.toHaveBeenCalled();
    expect(document.activeElement).not.toBe(box);
  });

  it("final review #7: if LUME never hears the tab come back, Back from WhatsApp asks Sent?", async () => {
    tab();
    render(<QueueRun id="q1" />);
    await screen.findByDisplayValue("Hi Aisha, just checking in.");
    await userEvent.click(screen.getByRole("button", { name: "Send" }));
    await userEvent.click(await screen.findByRole("button", { name: "Back from WhatsApp" }));
    expect(await screen.findByRole("group", { name: "Was the WhatsApp message sent?" })).toBeInTheDocument();
  });

  it("final review #7: the page becoming visible again counts as coming back", async () => {
    tab();
    render(<QueueRun id="q1" />);
    await screen.findByDisplayValue("Hi Aisha, just checking in.");
    await userEvent.click(screen.getByRole("button", { name: "Send" }));
    await screen.findByRole("button", { name: "Back from WhatsApp" });
    await act(async () => void document.dispatchEvent(new Event("visibilitychange")));
    expect(await screen.findByRole("group", { name: "Was the WhatsApp message sent?" })).toBeInTheDocument();
  });

  it("reduced motion: the cards cross-fade instead of sliding", async () => {
    reduce = true;
    render(<QueueRun id="q1" />);
    await lead("Aisha Khan");
    expect(screen.getByTestId("queue-card")).toHaveAttribute("data-motion", "fade");
  });
});
