import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { queuesClient, type LumeChannel, type QueueItemStatus, type QueueView } from "@/lib/queues/client";
import { whatsappClient } from "@/lib/whatsapp/client";
import type { WaThreadMessage } from "@/lib/whatsapp/types";
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
    retry: vi.fn(),
    channel: vi.fn(),
    sendItem: vi.fn(),
    handed: vi.fn(),
  },
}));
vi.mock("@/lib/whatsapp/client", async (orig) => ({
  ...(await orig<typeof import("@/lib/whatsapp/client")>()),
  whatsappClient: { thread: vi.fn() },
}));
let hear: ((e: { lead: string }) => void) | null = null;
vi.mock("@/lib/notifications/stream", async (orig) => ({
  ...(await orig<typeof import("@/lib/notifications/stream")>()),
  useWhatsApp: (on: (e: { lead: string }) => void) => {
    hear = on;
  },
}));
vi.mock("@/components/autopilot/StartSheet", () => ({
  StartSheet: (p: { target: { leadIds: string[] }; onStarted(r: { run: { id: string } }): void }) => (
    <div role="dialog" aria-label="Start sheet">
      {p.target.leadIds.join(",")}
      <button type="button" onClick={() => p.onStarted({ run: { id: "ai1" } })}>
        Start
      </button>
    </div>
  ),
}));
const play = vi.fn();
vi.mock("@/components/feedback/SoundProvider", () => ({ useSound: () => ({ play }) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }) }));

const ok = <T,>(data: T) => ({ ok: true as const, status: 200, data });
const NAMES = ["Aisha Khan", "Bea Lopez", "Chen Wei"];
let q: QueueView;
let thread: WaThreadMessage[];
const outside: LumeChannel = {
  via: "lume",
  window: { open: false, lastInAt: null, until: null },
  template: {
    submissionId: "s1",
    name: "First hello",
    preview: "Hi Aisha, this is the studio.",
    missing: [],
  },
  text: "Hi Aisha, this is the studio.",
};
const out = (status: WaThreadMessage["status"], problem: string | null = null): WaThreadMessage =>
  ({
    id: "sent1",
    direction: "out",
    at: new Date().toISOString(),
    text: "Hi Aisha, this is the studio.",
    media: null,
    sentBy: { id: "u1", name: "Riya" },
    status,
    problem,
    outboxId: "o1",
    lumeAi: null,
  }) as WaThreadMessage;

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  hear = null;
  thread = [];
  q = {
    id: "q1",
    status: "active",
    pausedReason: null,
    templateName: "First hello",
    sourceName: "New this week",
    total: 3,
    done: { sent: 0, notSent: 0, skipped: 0 },
    today: { sent: 3, cap: 150 },
    items: NAMES.map((name, position) => ({
      position,
      leadId: `l${position}`,
      name,
      stageName: "New",
      status: "pending" as QueueItemStatus,
      reason: null,
    })),
  };
  vi.mocked(queuesClient.get).mockImplementation(async () => ok(structuredClone(q)));
  vi.mocked(queuesClient.text).mockImplementation(async () => ok({ text: "Hi", missing: [] }));
  vi.mocked(queuesClient.channel).mockImplementation(async () => ok(outside));
  vi.mocked(whatsappClient.thread).mockImplementation(async () =>
    ok({ on: true, reply: null, messages: thread }),
  );
  vi.mocked(queuesClient.sendItem).mockImplementation(async (_id, pos) => {
    q.items[pos]!.status = "sent";
    thread = [out("queued")];
    return ok({ message: thread[0]!, next: pos + 1 < NAMES.length ? pos + 1 : null });
  });
  vi.mocked(queuesClient.handed).mockImplementation(async () => {
    for (const i of q.items)
      if (i.status === "pending") Object.assign(i, { status: "skipped", reason: "Handed to LUME AI" });
    q.status = "finished";
    return ok(structuredClone(q));
  });
});

describe("the run, sent from inside LUME", () => {
  it("Send goes through LUME: no WhatsApp tab, no Sent?; WhatsApp takes it, Sent, and the next lead comes", async () => {
    const open = vi.spyOn(window, "open");
    render(<QueueRun id="q1" />);
    expect(await screen.findByText("Sends your approved template First hello")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /^Send/ }));
    expect(queuesClient.sendItem).toHaveBeenCalledWith("q1", 0, {
      mode: "template",
      clientKey: expect.any(String),
    });
    expect(open).not.toHaveBeenCalled();
    expect(queuesClient.prepare).not.toHaveBeenCalled();
    expect(screen.queryByText(/Sent\?/)).toBeNull();
    // WhatsApp took it: the stream says so.
    thread = [out("sent")];
    await act(async () => hear?.({ lead: "l0" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Sent");
    expect(play).toHaveBeenCalledWith("sent");
    expect(await screen.findByRole("heading", { name: "Bea Lopez" })).toBeInTheDocument();
  });

  it("while LUME finds out how the lead goes, nothing can be sent either way", async () => {
    vi.mocked(queuesClient.channel).mockReturnValue(new Promise(() => {}) as never);
    render(<QueueRun id="q1" />);
    expect(await screen.findByText("Getting Aisha ready…")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Send/ })).toBeNull();
    await userEvent.keyboard("{Enter}");
    expect(queuesClient.prepare).not.toHaveBeenCalled();
    expect(queuesClient.sendItem).not.toHaveBeenCalled();
  });

  it("one press, one send: a second Enter while it goes posts nothing more", async () => {
    let answer: (v: unknown) => void = () => {};
    vi.mocked(queuesClient.sendItem).mockReturnValue(new Promise((r) => (answer = r)) as never);
    render(<QueueRun id="q1" />);
    await screen.findByText("Sends your approved template First hello");
    await userEvent.click(screen.getByRole("button", { name: /^Send/ }));
    await userEvent.keyboard("{Enter}");
    expect(queuesClient.sendItem).toHaveBeenCalledTimes(1);
    answer(ok({ message: out("queued"), next: 1 }));
  });

  it("WhatsApp refuses it: its words, Try again sends it again", async () => {
    render(<QueueRun id="q1" />);
    await screen.findByText("Sends your approved template First hello");
    await userEvent.click(screen.getByRole("button", { name: /^Send/ }));
    thread = [out("failed", "This number isn't on WhatsApp.")];
    q.items[0]!.status = "not_sent";
    await act(async () => hear?.({ lead: "l0" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("This number isn't on WhatsApp.");
    vi.mocked(queuesClient.retry).mockImplementation(async () => {
      q.items[0]!.status = "pending";
      return ok({ next: 0 });
    });
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(queuesClient.retry).toHaveBeenCalledWith("q1", 0);
    expect(await screen.findByRole("button", { name: /^Send/ })).toBeEnabled();
  });

  it("no answer from WhatsApp in 10 seconds: LUME keeps trying, and the next lead comes", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      render(<QueueRun id="q1" />);
      await screen.findByText("Sends your approved template First hello");
      await userEvent.click(screen.getByRole("button", { name: /^Send/ }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_500);
      });
      expect(screen.getByRole("status")).toHaveTextContent("Still sending, LUME will keep trying");
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_000);
      });
      expect(await screen.findByRole("heading", { name: "Bea Lopez" })).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("their 24 hours ended while the card was open: the card looks again and offers the template", async () => {
    vi.mocked(queuesClient.channel).mockResolvedValueOnce(
      ok({
        ...outside,
        window: { open: true, lastInAt: new Date().toISOString(), until: new Date().toISOString() },
      }),
    );
    vi.mocked(queuesClient.sendItem).mockResolvedValueOnce({
      ok: false,
      status: 409,
      code: "WINDOW_CLOSED",
      message: "They haven't written in 24 hours, so only the template can go.",
    } as never);
    render(<QueueRun id="q1" />);
    await userEvent.click(await screen.findByRole("button", { name: /^Send/ }));
    expect(
      await screen.findByText("They haven't written in 24 hours, so only the template can go."),
    ).toBeInTheDocument();
    expect(queuesClient.channel).toHaveBeenCalledTimes(2);
    expect(await screen.findByText("Sends your approved template First hello")).toBeInTheDocument();
  });

  it("a lead that goes WhatsApp's way keeps today's flow, and says why", async () => {
    vi.mocked(queuesClient.channel).mockResolvedValue(
      ok({ via: "whatsapp", why: "This lead has no WhatsApp number." } as LumeChannel),
    );
    render(<QueueRun id="q1" />);
    expect(await screen.findByText("Opens WhatsApp: This lead has no WhatsApp number.")).toBeInTheDocument();
    expect(screen.queryByText("Sends your approved template First hello")).toBeNull();
  });

  it("their reply arrives while the card is open: it shows", async () => {
    render(<QueueRun id="q1" />);
    await screen.findByText("Sends your approved template First hello");
    thread = [
      {
        ...out(null),
        id: "in1",
        direction: "in",
        text: "Hi! Is it still open?",
        sentBy: null,
        outboxId: null,
      } as WaThreadMessage,
    ];
    await act(async () => hear?.({ lead: "l0" }));
    expect(await screen.findByText("Hi! Is it still open?")).toBeInTheDocument();
  });

  it("Let LUME AI take the rest: the leads still waiting, and the run takes note", async () => {
    render(<QueueRun id="q1" canAi />);
    await screen.findByText("Sends your approved template First hello");
    await userEvent.click(screen.getByRole("button", { name: "Let LUME AI take the rest" }));
    expect(screen.getByRole("dialog", { name: "Start sheet" })).toHaveTextContent("l0,l1,l2");
    await userEvent.click(screen.getByRole("button", { name: "Start" }));
    expect(queuesClient.handed).toHaveBeenCalledWith("q1", "ai1");
  });

  it("a late answer about the lead before is dropped: never its way or its conversation under the next one's name", async () => {
    let late: (v: unknown) => void = () => {};
    vi.mocked(queuesClient.channel).mockImplementation(async (_id, pos) =>
      pos === 0 ? ((await new Promise((r) => (late = r as (v: unknown) => void))) as never) : ok(outside),
    );
    vi.mocked(queuesClient.skip).mockImplementation(async () => {
      q.items[0]!.status = "skipped";
      return ok({ next: 1 });
    });
    render(<QueueRun id="q1" />);
    expect(await screen.findByText("Getting Aisha ready…")).toBeInTheDocument();
    await userEvent.keyboard("s");
    expect(await screen.findByText("Sends your approved template First hello")).toBeInTheDocument();
    await act(async () => late(ok({ via: "whatsapp", why: "Old answer" })));
    expect(screen.getByText("Sends your approved template First hello")).toBeInTheDocument();
    expect(screen.queryByText(/Old answer/)).toBeNull();
  });

  it("a late conversation of the lead before never shows under the next one's name", async () => {
    let late: (v: unknown) => void = () => {};
    vi.mocked(whatsappClient.thread).mockImplementation(async (leadId) =>
      leadId === "l0"
        ? ((await new Promise((r) => (late = r as (v: unknown) => void))) as never)
        : ok({ on: true, reply: null, messages: [] }),
    );
    vi.mocked(queuesClient.skip).mockImplementation(async () => {
      q.items[0]!.status = "skipped";
      return ok({ next: 1 });
    });
    render(<QueueRun id="q1" />);
    await screen.findByText("Sends your approved template First hello");
    await userEvent.keyboard("s");
    expect(await screen.findByRole("heading", { name: "Bea Lopez" })).toBeInTheDocument();
    expect(await screen.findByText("No messages with them yet")).toBeInTheDocument();
    await act(async () =>
      late(
        ok({
          on: true,
          reply: null,
          messages: [{ ...out(null), id: "a1", direction: "in", text: "Aisha's own words" }],
        }),
      ),
    );
    expect(screen.queryByText("Aisha's own words")).toBeNull();
  });

  it("paused for a reason that stops every send: the run says it", async () => {
    q.status = "paused";
    q.pausedReason = "This month's paid WhatsApp messages are used up (1 of 1). An admin can ask for more.";
    render(<QueueRun id="q1" />);
    expect(
      await screen.findByText(
        "This month's paid WhatsApp messages are used up (1 of 1). An admin can ask for more. LUME kept your place.",
      ),
    ).toBeInTheDocument();
  });

  it("LUME AI never takes the lead just messaged, while it waits for WhatsApp's answer", async () => {
    vi.mocked(queuesClient.sendItem).mockImplementation(async () => {
      thread = [out("queued")];
      return ok({ message: thread[0]!, next: 1 });
    });
    render(<QueueRun id="q1" canAi />);
    await screen.findByText("Sends your approved template First hello");
    await userEvent.click(screen.getByRole("button", { name: /^Send/ }));
    await userEvent.click(screen.getByRole("button", { name: "Let LUME AI take the rest" }));
    expect(await screen.findByRole("dialog", { name: "Start sheet" })).toHaveTextContent(/^l1,l2Start$/);
  });

  it("the run says which number it sends from (owner 2026-11-26)", async () => {
    q.number = { display: "+91 90000 00002", whose: "the business's" };
    render(<QueueRun id="q1" />);
    expect(await screen.findByText("From +91 90000 00002")).toBeInTheDocument();
  });

  it("no LUME AI here: no such button", async () => {
    render(<QueueRun id="q1" />);
    await screen.findByText("Sends your approved template First hello");
    expect(screen.queryByRole("button", { name: "Let LUME AI take the rest" })).toBeNull();
  });
});
