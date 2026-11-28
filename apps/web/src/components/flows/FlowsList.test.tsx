import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { dayIn, daysOf } from "@/lib/analytics/range";
import { flowsClient, type FlowListItem, type FlowTrigger } from "@/lib/flows/client";
import { FlowsList } from "./FlowsList";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
vi.mock("@/lib/flows/client", () => ({
  flowsClient: {
    list: vi.fn(),
    summary: vi.fn(),
    setStatus: vi.fn(),
    create: vi.fn(),
    stats: vi.fn(),
    get: vi.fn(),
  },
}));
const ok = <T,>(data: T) => ({ ok: true as const, status: 200, data });
const trigger = (over: Partial<FlowTrigger> = {}): FlowTrigger => ({
  kind: "comment",
  accountId: null,
  keywords: ["GUIDE"],
  mode: "word",
  mediaIds: [],
  adIds: [],
  publicReplies: [],
  cooldownHours: 24,
  enabled: true,
  ...over,
});
const flow = (over: Partial<FlowListItem> = {}): FlowListItem => ({
  id: "f1",
  name: "Lead magnet",
  status: "live",
  priority: 0,
  rev: 4,
  version: 2,
  updatedAt: "2026-11-24T10:00:00.000Z",
  triggers: [trigger()],
  active: 3,
  ...over,
});
const counts = (triggered: number, leads: number, won = 0) => ({
  triggered,
  finished: Math.round(triggered / 2),
  leads,
  handed: 1,
  booked: 2,
  won,
  revenue: won * 9000,
});
const days30 = Array.from({ length: 30 }, (_, i) => ({
  day: `2026-10-${String(i + 1).padStart(2, "0")}`,
  comment: i % 3,
  dm: 1,
  ad: 0,
  story: 0,
}));
const board = {
  series: days30,
  sources: [{ kind: "reels", id: "17980000000000001", conversations: 140, leads: 52 }],
  sourcesByFlow: [{ flowId: "f1", kind: "reels", id: "17980000000000001", conversations: 140, leads: 52 }],
  notes: [
    {
      id: "ran_out",
      title: "4 passed to your team waited too long",
      body: "A flow asked for a person.",
    },
  ],
};
const extra = { bookedNew: 25, wonNew: 11, firstAnswerSec: 3, teamAnswerSec: 840, ranOut: 4, stopped: 1 };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(flowsClient.list).mockResolvedValue(
    ok({
      flows: [
        flow(),
        flow({
          id: "f2",
          name: "Qualify and book",
          triggers: [trigger({ kind: "dm", keywords: ["price", "cost", "fees"] })],
          active: 0,
          rev: 7,
        }),
        flow({ id: "f3", name: "Spring batch", status: "draft", version: null, triggers: [], active: 0 }),
      ],
    }),
  );
  vi.mocked(flowsClient.summary).mockResolvedValue(
    ok({
      from: "2026-10-27",
      to: "2026-11-25",
      total: {
        triggered: 312,
        finished: 200,
        leads: 121,
        handed: 9,
        booked: 30,
        won: 13,
        revenue: 117000,
        ...extra,
      },
      flows: [
        { id: "f1", ...counts(212, 88, 9) },
        { id: "f2", ...counts(100, 33, 4) },
        { id: "f3", ...counts(0, 0) },
      ],
      ...board,
    }),
  );
});

/** The days a choice covers, ending today where the business is (UTC by default). */
const daysFor = (choice: "7d" | "30d") => {
  const [from, to] = daysOf(choice, dayIn(new Date(), "UTC"));
  return { from, to };
};

describe("the Flows page (plan 2026-11-25-instagram-screens D3; canvas board Flows)", () => {
  it("says what the flows did, in tiles and one line", async () => {
    render(<FlowsList />);
    expect(
      await screen.findByRole("heading", { name: "Flows answered 312 conversations. 121 became leads." }),
    ).toBeVisible();
    const tiles = screen.getByRole("list", { name: "What the flows did" });
    expect(within(tiles).getByText("Conversations started").parentElement).toHaveTextContent("312");
    expect(within(tiles).getByText("Became leads").parentElement).toHaveTextContent("39% who started");
    expect(within(tiles).getByText("Calls booked").parentElement).toHaveTextContent(
      "After a flow answered them",
    );
    expect(within(tiles).getByText("Passed to your team").parentElement).toHaveTextContent("9");
    expect(flowsClient.summary).toHaveBeenCalledWith(daysFor("30d"));
  });

  it("every flow: what starts it, whether it's on, who's in it now and what it brought", async () => {
    render(<FlowsList />);
    const table = await screen.findByRole("table", { name: "Every flow" });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent("Lead magnet");
    expect(rows[0]).toHaveTextContent("Comment “GUIDE”");
    expect(rows[0]).toHaveTextContent("212");
    expect(rows[0]).toHaveTextContent("88");
    expect(rows[0]).toHaveTextContent("42%");
    expect(rows[1]).toHaveTextContent("DM “price” +2");
    expect(within(rows[0]!).getByRole("link", { name: "Lead magnet" })).toHaveAttribute(
      "href",
      "/instagram/flows/f1",
    );
    expect(within(rows[0]!).getByRole("switch", { name: "Lead magnet is on" })).toBeChecked();
  });

  it("a draft can't be switched on from here: it says why, and opens to publish", async () => {
    render(<FlowsList />);
    const table = await screen.findByRole("table", { name: "Every flow" });
    const draft = within(table).getByRole("row", { name: /Spring batch/ });
    expect(draft).toHaveTextContent("Draft");
    expect(draft).toHaveTextContent("Nothing starts it yet");
    expect(within(draft).queryByRole("switch")).toBeNull();
    // A flow that started nobody shows dashes, never NaN or 0%.
    expect(draft).not.toHaveTextContent("NaN");
    expect(draft).toHaveTextContent("—");
  });

  it("switching a live flow off sends its rev; refused, it says why and stays as it was", async () => {
    vi.mocked(flowsClient.setStatus).mockResolvedValueOnce({
      ok: false,
      status: 409,
      code: "FLOW_CHANGED",
      message: "Someone else changed this flow meanwhile. Reload to see their changes.",
    } as never);
    render(<FlowsList />);
    const sw = await screen.findByRole("switch", { name: "Lead magnet is on" });
    await userEvent.click(sw);
    expect(flowsClient.setStatus).toHaveBeenCalledWith("f1", 4, "paused");
    expect(await screen.findByRole("alert")).toHaveTextContent("Someone else changed this flow meanwhile.");
    expect(screen.getByRole("switch", { name: "Lead magnet is on" })).toBeChecked();
  });

  it("switching off, accepted: the row says Off and the list is read again", async () => {
    vi.mocked(flowsClient.setStatus).mockResolvedValue(ok({} as never));
    render(<FlowsList />);
    await userEvent.click(await screen.findByRole("switch", { name: "Lead magnet is on" }));
    await waitFor(() => expect(flowsClient.list).toHaveBeenCalledTimes(2));
  });

  it("sorts by a heading; again reverses it", async () => {
    render(<FlowsList />);
    const table = await screen.findByRole("table", { name: "Every flow" });
    const names = () =>
      within(table)
        .getAllByRole("row")
        .slice(1)
        .map((r) => within(r).getAllByRole("link")[0]!.textContent);
    await userEvent.click(within(table).getByRole("button", { name: "Leads" }));
    expect(names()).toEqual(["Lead magnet", "Qualify and book", "Spring batch"]);
    expect(within(table).getByRole("columnheader", { name: "Leads" })).toHaveAttribute(
      "aria-sort",
      "descending",
    );
    await userEvent.click(within(table).getByRole("button", { name: "Leads" }));
    expect(names()).toEqual(["Spring batch", "Qualify and book", "Lead magnet"]);
  });

  it("another range asks again for those days", async () => {
    render(<FlowsList />);
    await screen.findByRole("table", { name: "Every flow" });
    await userEvent.click(screen.getByRole("button", { name: /Last 30 days/ }));
    await userEvent.click(
      within(screen.getByRole("dialog", { name: "Date range" })).getByRole("button", { name: "Last 7 days" }),
    );
    expect(flowsClient.summary).toHaveBeenLastCalledWith(daysFor("7d"));
  });

  // Owner 2026-11-28: "the flow metrics dont have the custom date filter, they only show 7 30 90 days".
  it("a custom range: two days on the calendar, and the numbers are for those days", async () => {
    // A fixed day mid-month, so the calendar always has the days the test picks (review 2026-11-28).
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-18T09:00:00Z"));
    render(<FlowsList />);
    await screen.findByRole("table", { name: "Every flow" });
    await userEvent.click(screen.getByRole("button", { name: /Last 30 days/ }));
    const cal = screen.getByRole("dialog", { name: "Date range" });
    const days = within(cal)
      .getAllByRole("button")
      .filter((b) => /^\d+$/.test(b.textContent ?? "") && !b.hasAttribute("disabled"));
    const a = days[2]!;
    const b = days[5]!;
    await userEvent.click(a);
    await userEvent.click(b);
    const call = vi.mocked(flowsClient.summary).mock.lastCall![0];
    expect(call.to > call.from).toBe(true);
    expect((Date.parse(call.to) - Date.parse(call.from)) / 86_400_000).toBe(3);
    expect(screen.queryByRole("switch", { name: /Compare/ })).not.toBeInTheDocument();
    vi.useRealTimers();
  });

  it("no flows yet: what a flow does, and New flow", async () => {
    vi.mocked(flowsClient.list).mockResolvedValue(ok({ flows: [] }));
    vi.mocked(flowsClient.summary).mockResolvedValue(
      ok({
        from: "x",
        to: "y",
        total: { ...counts(0, 0), handed: 0, booked: 0, ...extra },
        flows: [],
        ...board,
      }),
    );
    render(<FlowsList />);
    expect(await screen.findByText("No flows yet")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "New flow" }).length).toBeGreaterThan(0);
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("Instagram off: says so and where to switch it on", async () => {
    vi.mocked(flowsClient.list).mockResolvedValue({
      ok: false,
      status: 409,
      code: "INSTAGRAM_OFF",
      message: "Instagram is off. Switch it on in Settings → Integrations first.",
    } as never);
    render(<FlowsList />);
    expect(await screen.findByText(/Instagram is off/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open Integrations" })).toHaveAttribute(
      "href",
      "/settings/integrations#instagram",
    );
  });

  it("the list can't be read: says so with Try again", async () => {
    vi.mocked(flowsClient.list).mockResolvedValueOnce({
      ok: false,
      status: 0,
      code: "OFFLINE",
      message: "offline",
    } as never);
    render(<FlowsList />);
    await userEvent.click(await screen.findByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("table", { name: "Every flow" })).toBeInTheDocument();
  });

  it("numbers that can't be read leave the list, with dashes where they'd be", async () => {
    vi.mocked(flowsClient.summary).mockResolvedValue({
      ok: false,
      status: 0,
      code: "OFFLINE",
      message: "x",
    } as never);
    render(<FlowsList />);
    const table = await screen.findByRole("table", { name: "Every flow" });
    expect(within(table).getByRole("row", { name: /Lead magnet/ })).toHaveTextContent("—");
    expect(screen.getByRole("status")).toHaveTextContent("LUME couldn't count these days");
  });

  it("the board (D6b-2): finished, the money, the first answer, the team's answer, ran out, asked to stop", async () => {
    render(<FlowsList currency="INR" />);
    const tiles = await screen.findByRole("list", { name: "What the flows did" });
    expect(within(tiles).getByText("Time to answer ran out").parentElement).toHaveTextContent(
      "Passed on, nobody answered in Instagram’s window",
    );
    // The path from start to won follows the leads the flows made: 25 of them booked, of all 30 calls.
    expect(screen.getByRole("region", { name: "Where people stop" })).toHaveTextContent("Booked a call25");
    expect(within(tiles).getByText("Finished the flow").parentElement).toHaveTextContent("64%");
    expect(within(tiles).getByText("Revenue won").parentElement).toHaveTextContent(
      "From 13 leads won after a flow",
    );
    expect(within(tiles).getByText("First answer (median)").parentElement).toHaveTextContent("3 sec");
    expect(within(tiles).getByText("Your team’s answer (median)").parentElement).toHaveTextContent("14 min");
    expect(within(tiles).getByText("Time to answer ran out").parentElement).toHaveTextContent("4");
    expect(within(tiles).getByText("Asked to stop").parentElement).toHaveTextContent("1");
    const table = screen.getByRole("table", { name: "Every flow" });
    expect(within(table).getByRole("columnheader", { name: "Revenue" })).toBeVisible();
    expect(within(table).getByRole("row", { name: /Lead magnet/ })).toHaveTextContent("50%");
    expect(screen.getByRole("region", { name: "The posts and ads that started them" })).toHaveTextContent(
      "Reel17980000000000001140 started52 leads",
    );
    expect(screen.getByRole("region", { name: "LUME noticed" })).toHaveTextContent(
      "4 passed to your team waited too long",
    );
    expect(document.body.textContent).not.toMatch(/NaN|undefined/);
  });

  it("someone who doesn't see money: no revenue tile or column", async () => {
    vi.mocked(flowsClient.summary).mockResolvedValue(
      ok({
        from: "x",
        to: "y",
        total: { ...counts(10, 4), revenue: null, ...extra },
        flows: [{ id: "f1", ...counts(10, 4), revenue: null }],
        ...board,
      }),
    );
    render(<FlowsList currency="INR" />);
    const table = await screen.findByRole("table", { name: "Every flow" });
    expect(within(table).queryByRole("columnheader", { name: "Revenue" })).toBeNull();
    expect(screen.queryByText("Revenue won")).toBeNull();
  });

  it("the business's currency unknown: no money shown, never a made-up currency", async () => {
    render(<FlowsList />);
    const table = await screen.findByRole("table", { name: "Every flow" });
    expect(within(table).queryByRole("columnheader", { name: "Revenue" })).toBeNull();
    expect(screen.queryByText("Revenue won")).toBeNull();
  });

  it("where people stop: all flows, or one flow's steps in the order people reach them, the biggest drop marked", async () => {
    vi.mocked(flowsClient.stats).mockResolvedValue(
      ok({
        total: { triggered: 212, leads: 88, handed: 1, booked: 2, won: 9 },
        byStep: {
          ask: { entered: 150, people: 150, sent: 150 },
          hi: { entered: 200, people: 200, sent: 200 },
          wait: { entered: 190, people: 190, sent: 0 },
        },
        byLine: {},
      }) as never,
    );
    vi.mocked(flowsClient.get).mockResolvedValue(
      ok({
        live: null,
        graph: {
          v: 2,
          start: "hi",
          // The canvas's order isn't the order people reach them: the numbers decide.
          nodes: [
            { id: "ask", type: "ask", text: "What's your goal?", save: null, next: null },
            { id: "wait", type: "wait", for: { minutes: 60 }, next: "ask" },
            { id: "hi", type: "message", text: "Here's the guide", buttons: [], replies: [], next: "wait" },
          ],
          pos: {},
          notes: [],
        },
      }) as never,
    );
    render(<FlowsList />);
    const card = await screen.findByRole("region", { name: "Where people stop" });
    expect(card).toHaveTextContent("Finished the flow");
    await userEvent.selectOptions(within(card).getByRole("combobox", { name: "Flow" }), "f1");
    expect(flowsClient.stats).toHaveBeenCalledWith("f1", daysFor("30d"));
    await waitFor(() => expect(card).toHaveTextContent("Message: Here's the guide"));
    const text = card.textContent!;
    // Started, then its steps by how many reached them (a wait isn't a step a person does), then what they led to.
    expect(text.indexOf("Started")).toBeLessThan(text.indexOf("Message: Here's the guide"));
    expect(text.indexOf("Message: Here's the guide")).toBeLessThan(text.indexOf("Ask: What's your goal?"));
    expect(text).not.toContain("Wait");
    // More went without becoming a lead after the question (62) than stopped at the message (50): becoming a lead
    // isn't a step of the flow, so the message is where the most stop.
    expect(card).toHaveTextContent("50 stopped here · the most of any step");
    // A flow nobody started isn't offered.
    expect(within(card).queryByRole("option", { name: "Spring batch" })).toBeNull();
  });

  it("a switch pressed twice sends once, so no false someone-else-changed-it", async () => {
    let answer: (v: unknown) => void = () => {};
    vi.mocked(flowsClient.setStatus).mockReturnValue(new Promise((r) => (answer = r)) as never);
    render(<FlowsList />);
    const sw = await screen.findByRole("switch", { name: "Lead magnet is on" });
    await userEvent.click(sw);
    await userEvent.click(sw);
    answer(ok({} as never));
    await waitFor(() => expect(flowsClient.list).toHaveBeenCalledTimes(2));
    expect(flowsClient.setStatus).toHaveBeenCalledTimes(1);
  });
});
