import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { flowsClient, type FlowListItem, type FlowTrigger } from "@/lib/flows/client";
import { FlowsList } from "./FlowsList";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
vi.mock("@/lib/flows/client", () => ({
  flowsClient: { list: vi.fn(), summary: vi.fn(), setStatus: vi.fn(), create: vi.fn() },
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
  leads,
  handed: 1,
  booked: 2,
  won,
});

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
      total: { triggered: 312, leads: 121, handed: 9, booked: 30, won: 13 },
      flows: [
        { id: "f1", ...counts(212, 88, 9) },
        { id: "f2", ...counts(100, 33, 4) },
        { id: "f3", ...counts(0, 0) },
      ],
    }),
  );
});

describe("the Flows page (plan 2026-11-25-instagram-screens D3; canvas board Flows)", () => {
  it("says what the flows did, in tiles and one line", async () => {
    render(<FlowsList />);
    expect(
      await screen.findByRole("heading", { name: "Flows answered 312 conversations. 121 became leads." }),
    ).toBeVisible();
    const tiles = screen.getByRole("list", { name: "What the flows did" });
    expect(within(tiles).getByText("Conversations started").parentElement).toHaveTextContent("312");
    expect(within(tiles).getByText("Became leads").parentElement).toHaveTextContent("39% who started");
    expect(within(tiles).getByText("Calls booked").parentElement).toHaveTextContent("25% of those leads");
    expect(within(tiles).getByText("Passed to your team").parentElement).toHaveTextContent("9");
    expect(flowsClient.summary).toHaveBeenCalledWith(30);
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
    await userEvent.click(screen.getByRole("radio", { name: "7 days" }));
    expect(flowsClient.summary).toHaveBeenLastCalledWith(7);
  });

  it("no flows yet: what a flow does, and New flow", async () => {
    vi.mocked(flowsClient.list).mockResolvedValue(ok({ flows: [] }));
    vi.mocked(flowsClient.summary).mockResolvedValue(
      ok({ from: "x", to: "y", total: { triggered: 0, leads: 0, handed: 0, booked: 0, won: 0 }, flows: [] }),
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
