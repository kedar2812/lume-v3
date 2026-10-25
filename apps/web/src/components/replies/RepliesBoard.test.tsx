import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { bulkRunsClient } from "@/lib/leads/bulk-runs";
import { repliesClient, type ReplyBoard } from "@/lib/replies/client";
import { RepliesBoard } from "./RepliesBoard";

vi.mock("@/lib/leads/bulk-runs", async (orig) => ({
  ...(await orig<typeof import("@/lib/leads/bulk-runs")>()),
  bulkRunsClient: { create: vi.fn(), undo: vi.fn(), get: vi.fn() },
}));
vi.mock("@/lib/replies/client", () => ({ repliesClient: { board: vi.fn() } }));
vi.mock("@/components/ZoneProvider", () => ({ useZone: () => "Asia/Kolkata" }));
const toast = vi.fn();
vi.mock("@/components/feedback/ToastProvider", () => ({ useToast: () => ({ toast, dismiss: vi.fn() }) }));
const ok = <T,>(data: T) => ({ ok: true as const, status: 200, data });

const lead = (id: string, name: string, summary: string | null) => ({
  leadId: id,
  name,
  at: "2026-10-21T06:00:00.000Z",
  text: summary ?? "ok",
  summary,
  doNotContact: false,
});
const board = (o: Partial<Record<string, ReturnType<typeof lead>[]>> = {}): ReplyBoard => ({
  since: "2026-10-14T06:00:00.000Z",
  groups: (
    [
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
    expect(screen.getByText(/No WhatsApp replies since/)).toBeInTheDocument();
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
});
