import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bulkRunsClient } from "@/lib/leads/bulk-runs";
import { repliesClient, type ReplyBoard } from "@/lib/replies/client";
import { RepliesBoard } from "./RepliesBoard";

vi.mock("@/lib/leads/bulk-runs", async (orig) => ({
  ...(await orig<typeof import("@/lib/leads/bulk-runs")>()),
  bulkRunsClient: { create: vi.fn(), undo: vi.fn(), get: vi.fn() },
}));
vi.mock("@/lib/replies/client", () => ({ repliesClient: { board: vi.fn() } }));
vi.mock("@/components/ZoneProvider", () => ({ useZone: () => "Asia/Kolkata" }));
const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
// The start sheet has its own tests: here, which leads it's handed, and where a run started from it goes.
vi.mock("@/components/autopilot/StartSheet", () => ({
  StartSheet: (p: { target: { leadIds: string[] }; onStarted(r: { run: { id: string } }): void }) => (
    <div role="dialog" aria-label="Start sheet">
      {p.target.leadIds.join(",")}
      <button type="button" onClick={() => p.onStarted({ run: { id: "r9" } })}>
        Start
      </button>
    </div>
  ),
}));
const toast = vi.fn();
vi.mock("@/components/feedback/ToastProvider", () => ({ useToast: () => ({ toast, dismiss: vi.fn() }) }));
const ok = <T,>(data: T) => ({ ok: true as const, status: 200, data });

type Row = ReplyBoard["groups"][number]["leads"][number];
const lead = (id: string, name: string, summary: string | null, more: Partial<Row> = {}): Row => ({
  leadId: id,
  name,
  at: "2026-10-21T06:00:00.000Z",
  text: summary ?? "ok",
  summary,
  doNotContact: false,
  channel: "whatsapp",
  window: { state: "closed", until: null },
  ownerName: "Maya Kapoor",
  source: null,
  ...more,
});
const board = (
  o: Partial<Record<string, Row[]>> = {},
  channel: ReplyBoard["channel"] = "all",
): ReplyBoard => ({
  since: "2026-10-14T06:00:00.000Z",
  channel,
  groups: (
    [
      "flow_passed",
      "interested",
      "price",
      "visit_or_call",
      "later",
      "not_interested",
      "stop",
      "wrong_number",
      "not_sure",
    ] as const
  ).map((group) => ({ group, count: o[group]?.length ?? 0, leads: o[group] ?? [] })),
});
const stages = [
  { id: "s-new", name: "New enquiry", kind: "open" as const },
  { id: "s-visit", name: "Site visit booked", kind: "open" as const },
  { id: "s-lost", name: "Lost", kind: "lost" as const },
];
const lostReasons = [{ id: "r-price", label: "Too expensive" }];
const run = { id: "run1", status: "done", done: 2, skipped: 0 };
const show = (b: ReplyBoard, canBulk = true) =>
  render(<RepliesBoard initial={b} stages={stages} lostReasons={lostReasons} canBulk={canBulk} />);

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(bulkRunsClient.create).mockResolvedValue(ok({ run }) as never);
  vi.mocked(bulkRunsClient.undo).mockResolvedValue(ok({ run: { ...run, id: "run2" } }) as never);
  vi.mocked(repliesClient.board).mockResolvedValue(ok(board()));
});

/** Who replied (W2, spec 2026-10-18 §4.2): replies grouped by what they mean, a bulk action per group, and Undo. */
describe("RepliesBoard", () => {
  it("each group that has replies, with how many, who and what they said; none at all says so", () => {
    const { unmount } = show(
      board({
        price: [lead("a", "Meera Iyer", "Asked what a kitchen costs.")],
        visit_or_call: [lead("b", "Rohan Gupta", "Wants a call tomorrow."), lead("c", "Sneha Reddy", null)],
      }),
    );
    const price = screen.getByRole("region", { name: "Asked the price, 1" });
    expect(within(price).getByRole("link", { name: /Meera Iyer/ })).toHaveAttribute("href", "/leads?lead=a");
    expect(within(price).getByText("Asked what a kitchen costs.")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Wants a visit or call, 2" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: /^Interested/ })).toBeNull();
    unmount();
    show(board());
    expect(screen.getByText(/No replies since/)).toBeInTheDocument();
  });

  it("Interested: move them all to a stage, as one bulk run, with Undo", async () => {
    show(
      board({ interested: [lead("a", "Meera Iyer", "Yes please"), lead("b", "Rohan Gupta", "Sounds good")] }),
    );
    const g = screen.getByRole("region", { name: "Interested, 2" });
    await userEvent.selectOptions(within(g).getByRole("combobox", { name: "Move the 2 to" }), "s-visit");
    await userEvent.click(within(g).getByRole("button", { name: "Move" }));
    expect(bulkRunsClient.create).toHaveBeenCalledWith(
      { ids: ["a", "b"] },
      { type: "stage", stageId: "s-visit" },
    );
    const said = toast.mock.calls.at(-1)![0] as { title: string; action: { label: string; onClick(): void } };
    expect(said.title).toBe("2 leads moved to Site visit booked");
    said.action.onClick();
    expect(bulkRunsClient.undo).toHaveBeenCalledWith("run1");
  });

  it("Asked the price, Later: a follow-up on each at one time, on the business's clock", async () => {
    show(board({ later: [lead("a", "Meera Iyer", "After Diwali")] }));
    const g = screen.getByRole("region", { name: "Later, 1" });
    fireEvent.change(within(g).getByLabelText("Follow up on"), { target: { value: "2026-11-10T11:00" } });
    await userEvent.click(within(g).getByRole("button", { name: "Set follow-up" }));
    expect(bulkRunsClient.create).toHaveBeenCalledWith(
      { ids: ["a"] },
      { type: "follow_up", at: "2026-11-10T05:30:00.000Z", title: "Check back with them" },
    );
  });

  it("Not interested: lost with a reason; Wrong number: do not contact; Stop messaging: already done", async () => {
    const b = board({
      not_interested: [lead("a", "Meera Iyer", "Too costly")],
      wrong_number: [lead("b", "Rohan Gupta", "Who is this?")],
      stop: [{ ...lead("c", "Sneha Reddy", null), doNotContact: true }],
    });
    // Read again after each run: the same replies (the leads are still there, only changed).
    vi.mocked(repliesClient.board).mockResolvedValue(ok(b));
    show(
      board({
        not_interested: [lead("a", "Meera Iyer", "Too costly")],
        wrong_number: [lead("b", "Rohan Gupta", "Who is this?")],
        stop: [{ ...lead("c", "Sneha Reddy", null), doNotContact: true }],
      }),
    );
    const no = screen.getByRole("region", { name: "Not interested, 1" });
    await userEvent.selectOptions(within(no).getByRole("combobox", { name: "Lost because" }), "r-price");
    await userEvent.click(within(no).getByRole("button", { name: "Mark lost" }));
    expect(bulkRunsClient.create).toHaveBeenCalledWith(
      { ids: ["a"] },
      { type: "stage", stageId: "s-lost", lostReasonId: "r-price" },
    );
    const wrong = screen.getByRole("region", { name: "Wrong number, 1" });
    await userEvent.click(within(wrong).getByRole("button", { name: "Mark do not contact" }));
    expect(bulkRunsClient.create).toHaveBeenLastCalledWith(
      { ids: ["b"] },
      { type: "do_not_contact", reason: "Wrong number" },
    );
    const stop = screen.getByRole("region", { name: "Stop messaging, 1" });
    expect(within(stop).getByText("LUME marked these do not contact.")).toBeInTheDocument();
    expect(within(stop).queryByRole("button")).toBeNull();
  });

  it("someone who can't change many leads at once sees the board without the actions", () => {
    show(board({ interested: [lead("a", "Meera Iyer", "Yes")] }), false);
    expect(within(screen.getByRole("region", { name: "Interested, 1" })).queryByRole("button")).toBeNull();
  });
  it("Let LUME AI handle these: a group LUME AI may follow up, into the start sheet with exactly its leads (2026-11-01)", async () => {
    render(
      <RepliesBoard
        initial={board({
          interested: [lead("l1", "Meera Iyer", "Wants a visit"), lead("l2", "Rohan Gupta", null)],
          not_interested: [lead("l3", "Kabir Shah", "No thanks")],
          stop: [lead("l4", "Isha Menon", "Stop")],
        })}
        stages={stages}
        lostReasons={lostReasons}
        canBulk
        canAi
      />,
    );
    // Never for those who said no or stop.
    expect(screen.getAllByRole("button", { name: /^Let LUME AI handle/ })).toHaveLength(1);
    await userEvent.click(screen.getByRole("button", { name: /^Let LUME AI handle these 2: / }));
    expect(screen.getByRole("dialog", { name: "Start sheet" })).toHaveTextContent("l1,l2");
    await userEvent.click(screen.getByRole("button", { name: "Start" }));
    expect(push).toHaveBeenCalledWith("/autopilot?run=r9");
  });

  it("LUME AI off, or someone who can't start a run: no Let LUME AI handle", () => {
    show(board({ interested: [lead("l1", "Meera Iyer", null)] }));
    expect(screen.queryByRole("button", { name: /^Let LUME AI handle/ })).toBeNull();
  });

  describe("with Instagram (D6a)", () => {
    const NOW = new Date("2026-11-25T06:00:00Z");
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(NOW);
    });
    afterEach(() => vi.useRealTimers());
    const inH = (h: number) => new Date(NOW.getTime() + h * 3_600_000).toISOString();

    it("each row: its channel, whose lead and where from, and how long a reply still reaches them", () => {
      show(
        board({
          interested: [
            lead("a", "Rohan Kapoor", "Loved the reel", {
              channel: "instagram",
              window: { state: "open", until: inH(21.5) },
              source: "Instagram",
            }),
            lead("b", "Ishaan Gupta", "Ready in December", {
              channel: "whatsapp",
              window: { state: "open", until: inH(19.2) },
              ownerName: null,
            }),
          ],
          price: [
            lead("c", "Kavya Rao", "How much?", {
              channel: "instagram",
              window: { state: "human", until: inH(30) },
              ownerName: "Sana Iqbal",
              source: "Website form",
            }),
            lead("d", "Dev Nair", "Any discount?", {
              channel: "whatsapp",
              window: { state: "closed", until: null },
            }),
          ],
        }),
      );
      const yes = screen.getByRole("region", { name: "Interested, 2" });
      const [ig, wa] = within(yes).getAllByRole("listitem");
      expect(within(ig!).getByRole("img", { name: "Instagram" })).toHaveAttribute(
        "src",
        "/brand/instagram.png",
      );
      expect(ig).toHaveTextContent("21 hours left to answer");
      expect(ig).toHaveTextContent("Maya Kapoor’s lead · Instagram");
      expect(within(wa!).getByRole("img", { name: "WhatsApp" })).toHaveAttribute(
        "src",
        "/brand/whatsapp-app.png",
      );
      expect(wa).toHaveTextContent("19 hours left on WhatsApp");
      expect(wa).toHaveTextContent("Nobody’s lead yet");
      const price = screen.getByRole("region", { name: "Asked the price, 2" });
      expect(price).toHaveTextContent(
        "Instagram’s 24 hours ended · a person can answer until tomorrow at 5:30 pm",
      );
      expect(price).toHaveTextContent("Sana Iqbal’s lead · Website form");
      expect(price).toHaveTextContent(
        "WhatsApp’s 24 hours ended · an approved template can still reach them",
      );
    });

    it("A flow passed these to you: first, the flow and why, no bulk action and no LUME AI", () => {
      render(
        <RepliesBoard
          initial={board({
            flow_passed: [
              lead("f1", "Ananya Iyer", null, {
                text: "Can you make a plan around my knee?",
                channel: "instagram",
                window: { state: "open", until: inH(21) },
                ownerName: "Sana Iqbal",
                flow: { name: "Qualify and book", note: "wants a custom plan" },
              }),
            ],
            interested: [lead("a", "Meera Iyer", "Yes")],
          })}
          stages={stages}
          lostReasons={lostReasons}
          canBulk
          canAi
        />,
      );
      const regions = screen.getAllByRole("region");
      expect(regions[0]).toHaveAccessibleName("A flow passed these to you, 1");
      const g = regions[0]!;
      expect(g).toHaveTextContent("Can you make a plan around my knee?");
      expect(g).toHaveTextContent(
        "Qualify and book asked for a person: wants a custom plan · Sana Iqbal’s lead",
      );
      expect(g).toHaveTextContent(/Each flow passed these to your team, and says why/);
      expect(within(g).queryByRole("button")).toBeNull();
      expect(within(g).queryByRole("combobox")).toBeNull();
    });

    it("Let LUME AI handle these: only a group's WhatsApp leads (Instagram waits for Part E)", async () => {
      render(
        <RepliesBoard
          initial={board({
            interested: [
              lead("w1", "Meera Iyer", "Yes"),
              lead("i1", "Rohan Kapoor", "Yes!", {
                channel: "instagram",
                window: { state: "open", until: inH(5) },
              }),
            ],
            price: [
              lead("i2", "Kavya Rao", "How much?", {
                channel: "instagram",
                window: { state: "open", until: inH(5) },
              }),
            ],
          })}
          stages={stages}
          lostReasons={lostReasons}
          canBulk
          canAi
        />,
      );
      // Asked the price holds only Instagram's: nothing LUME AI can do there yet.
      expect(screen.getAllByRole("button", { name: /^Let LUME AI handle/ })).toHaveLength(1);
      await userEvent.click(screen.getByRole("button", { name: /^Let LUME AI handle this 1: Interested/ }));
      expect(screen.getByRole("dialog", { name: "Start sheet" })).toHaveTextContent(/^w1Start$/);
    });

    it("the channel filter: shown when both are on the board; each reads its own; empty says which", async () => {
      const both = board({
        interested: [
          lead("w1", "Meera Iyer", "Yes"),
          lead("i1", "Rohan Kapoor", "Yes!", {
            channel: "instagram",
            window: { state: "open", until: inH(5) },
          }),
        ],
      });
      vi.mocked(repliesClient.board).mockResolvedValue(ok(board({}, "instagram")));
      show(both);
      const filter = screen.getByRole("radiogroup", { name: "Channel" });
      await act(async () => {
        fireEvent.click(within(filter).getByRole("radio", { name: "Instagram" }));
      });
      expect(repliesClient.board).toHaveBeenLastCalledWith(both.since, "instagram");
      await waitFor(() => expect(screen.getByText(/No Instagram replies since/)).toBeInTheDocument());
      expect(screen.getByText(/or a flow passes someone to your team/)).toBeInTheDocument();
      // The filter stays, so the way back is there.
      expect(screen.getByRole("radiogroup", { name: "Channel" })).toBeInTheDocument();
    });

    it("a channel that couldn't be read isn't left picked: the filter says what the board shows", async () => {
      const both = board({
        interested: [
          lead("w1", "Meera Iyer", "Yes"),
          lead("i1", "Rohan Kapoor", "Yes!", {
            channel: "instagram",
            window: { state: "open", until: inH(5) },
          }),
        ],
      });
      vi.mocked(repliesClient.board).mockResolvedValue({
        ok: false,
        status: 503,
        code: "X",
        message: "Offline",
      } as never);
      show(both);
      const filter = screen.getByRole("radiogroup", { name: "Channel" });
      await act(async () => {
        fireEvent.click(within(filter).getByRole("radio", { name: "Instagram" }));
      });
      await waitFor(() => expect(within(filter).getByRole("radio", { name: "All" })).toBeChecked());
      expect(toast).toHaveBeenCalledWith(
        expect.objectContaining({ title: "LUME couldn't read the replies" }),
      );
      expect(screen.getByText("Rohan Kapoor")).toBeInTheDocument();
    });

    it("only WhatsApp on the board: no filter", () => {
      show(board({ interested: [lead("w1", "Meera Iyer", "Yes")] }));
      expect(screen.queryByRole("radiogroup", { name: "Channel" })).toBeNull();
    });

    it("a slow answer for a channel left behind never replaces the one asked for after it", async () => {
      const both = board({
        interested: [
          lead("w1", "Meera Iyer", "Yes"),
          lead("i1", "Rohan Kapoor", "Yes!", {
            channel: "instagram",
            window: { state: "open", until: inH(5) },
          }),
        ],
      });
      let slow: (v: unknown) => void = () => {};
      vi.mocked(repliesClient.board)
        .mockImplementationOnce(() => new Promise((r) => (slow = r)) as never)
        .mockResolvedValueOnce(ok(board({ interested: [lead("w1", "Meera Iyer", "Yes")] }, "whatsapp")));
      show(both);
      const filter = screen.getByRole("radiogroup", { name: "Channel" });
      await act(async () => {
        fireEvent.click(within(filter).getByRole("radio", { name: "Instagram" }));
      });
      await act(async () => {
        fireEvent.click(within(filter).getByRole("radio", { name: "WhatsApp" }));
      });
      await act(async () => slow(ok(board({}, "instagram"))));
      expect(screen.getByRole("region", { name: "Interested, 1" })).toHaveTextContent("Meera Iyer");
      expect(screen.queryByText(/No Instagram replies/)).toBeNull();
    });
  });
});
