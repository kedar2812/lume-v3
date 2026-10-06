import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { bulkRunsClient, type RunView } from "@/lib/leads/bulk-runs";
import { testCatalog } from "@/lib/leads/test-catalog";
import { fakeSession } from "@/server/session";
import { CatalogProvider } from "../CatalogProvider";
import { Island } from "./Island";

vi.mock("@/lib/leads/bulk-runs", async (orig) => {
  const real = await orig<typeof import("@/lib/leads/bulk-runs")>();
  return {
    ...real,
    bulkRunsClient: { create: vi.fn(), get: vi.fn(), list: vi.fn(), cancel: vi.fn(), undo: vi.fn() },
  };
});
const toast = vi.fn();
vi.mock("@/components/feedback/ToastProvider", () => ({ useToast: () => ({ toast, dismiss: vi.fn() }) }));
const admin = fakeSession({
  permissions: [
    { key: "leads.view", scope: "all" },
    { key: "leads.bulk_edit", scope: "all" },
    { key: "leads.assign", scope: "all" },
    { key: "leads.delete", scope: "all" },
    { key: "leads.change_stage", scope: "all" },
    { key: "leads.edit", scope: "all" },
  ],
});
const catalog = testCatalog();
const person = catalog.people.find((p) => p.active)!;
const run = (over: Partial<RunView> = {}): RunView => ({
  id: "r1",
  userId: "u1",
  action: { type: "assign", ownerId: person.id },
  selection: { kind: "filter", total: 12408 },
  status: "done",
  total: 12408,
  done: 12396,
  skipped: 12,
  failed: 0,
  skippedBy: { LEAD_NOT_FOUND: 9, FORBIDDEN: 3 },
  error: null,
  createdAt: "2026-10-03T10:00:00Z",
  startedAt: "2026-10-03T10:00:00Z",
  finishedAt: "2026-10-03T10:00:26Z",
  undoOf: null,
  undoUntil: "2026-10-04T10:00:26Z",
  canUndo: true,
  ...over,
});
const island = (o: { count?: number; all?: boolean } = {}) => {
  const onFinished = vi.fn();
  const selection = vi.fn(() =>
    o.all ? { filters: { q: "mar" }, except: [], expected: o.count ?? 3 } : { ids: ["a", "b", "c"] },
  );
  render(
    <CatalogProvider catalog={catalog}>
      <Island
        session={admin}
        count={o.count ?? 3}
        allMatching={!!o.all}
        selection={selection}
        leadIds={o.all ? [] : ["a", "b", "c"]}
        phoneFixable={false}
        onFinished={onFinished}
        onClear={vi.fn()}
      />
    </CatalogProvider>,
  );
  return { onFinished, selection };
};
const ok = <T,>(data: T, status = 200) => ({ ok: true as const, status, data });
beforeEach(() => vi.clearAllMocks());

describe("the bulk island (7C)", () => {
  it("assigns everything that matches as one run, and shows the result with the reasons in words", async () => {
    vi.mocked(bulkRunsClient.create).mockResolvedValue(ok({ run: run() }));
    const { onFinished, selection } = island({ count: 12408, all: true });
    expect(screen.getByRole("toolbar", { name: "Bulk actions" })).toHaveTextContent("12,408");
    await userEvent.click(screen.getByRole("button", { name: /Assign/ }));
    await userEvent.click(screen.getByRole("menuitemradio", { name: new RegExp(person.name) }));
    await userEvent.click(
      screen.getByRole("button", { name: `Assign 12,408 to ${person.name.split(" ")[0]}` }),
    );
    expect(selection).toHaveBeenCalled();
    expect(bulkRunsClient.create).toHaveBeenCalledWith(
      { filters: { q: "mar" }, except: [], expected: 12408 },
      { type: "assign", ownerId: person.id },
    );
    expect(await screen.findByText(`12,396 leads assigned to ${person.name}`)).toBeInTheDocument();
    expect(onFinished).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole("button", { name: "12 skipped" }));
    expect(screen.getByRole("dialog", { name: "Why some were skipped" })).toHaveTextContent(
      "were deleted, or stopped being yours to see",
    );
  });

  it("a queued run is read back every second until it's done; Stop asks the server to stop", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.mocked(bulkRunsClient.create).mockResolvedValue(
      ok(
        {
          run: run({
            status: "queued",
            done: 0,
            skipped: 0,
            skippedBy: {},
            finishedAt: null,
            canUndo: false,
          }),
        },
        202,
      ),
    );
    vi.mocked(bulkRunsClient.get)
      .mockResolvedValueOnce(
        ok({
          run: run({
            status: "running",
            done: 4000,
            skipped: 0,
            skippedBy: {},
            finishedAt: null,
            canUndo: false,
          }),
        }),
      )
      .mockResolvedValue(ok({ run: run() }));
    vi.mocked(bulkRunsClient.cancel).mockResolvedValue(ok({ run: run({ status: "running" }) }));
    island({ count: 12408, all: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await user.click(screen.getByRole("button", { name: /Assign/ }));
    await user.click(screen.getByRole("menuitemradio", { name: new RegExp(person.name) }));
    await user.click(screen.getByRole("button", { name: /Assign 12,408 to/ }));
    // The reading starts once the run is made and shown; the first read lands a second after that.
    expect(await screen.findByRole("button", { name: "Stop" })).toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(screen.getByText("4,000")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Stop" }));
    expect(bulkRunsClient.cancel).toHaveBeenCalledWith("r1");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(await screen.findByText(`12,396 leads assigned to ${person.name}`)).toBeInTheDocument();
    const reads = vi.mocked(bulkRunsClient.get).mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });
    expect(vi.mocked(bulkRunsClient.get).mock.calls.length).toBe(reads);
    vi.useRealTimers();
  });

  it("Undo puts the leads back as a run; a refusal is said in words", async () => {
    vi.mocked(bulkRunsClient.create).mockResolvedValue(ok({ run: run() }));
    vi.mocked(bulkRunsClient.undo)
      .mockResolvedValueOnce(
        ok({
          run: run({
            id: "u1",
            action: { type: "undo", of: "assign" },
            total: 12396,
            done: 12392,
            skipped: 4,
            skippedBy: { CHANGED_SINCE: 4 },
            undoOf: "r1",
            canUndo: false,
          }),
        }),
      )
      .mockResolvedValueOnce({
        ok: false,
        status: 409,
        code: "ALREADY_UNDONE",
        message: "That bulk action has already been undone.",
      });
    island({ count: 12408, all: true });
    await userEvent.click(screen.getByRole("button", { name: /Assign/ }));
    await userEvent.click(screen.getByRole("menuitemradio", { name: new RegExp(person.name) }));
    await userEvent.click(screen.getByRole("button", { name: /Assign 12,408 to/ }));
    await userEvent.click(await screen.findByRole("button", { name: /^Undo$/ }));
    expect(await screen.findByText("12,392 leads put back")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "4 changed since" })).toBeInTheDocument();
  });

  it("a selection the server refuses (too many, or a search too broad) says why, in its words", async () => {
    vi.mocked(bulkRunsClient.create).mockResolvedValue({
      ok: false,
      status: 422,
      code: "TOO_MANY",
      message: "Narrow the selection: up to 50,000 leads at a time.",
    });
    island({ count: 61000, all: true });
    await userEvent.click(screen.getByRole("button", { name: /Assign/ }));
    await userEvent.click(screen.getByRole("menuitemradio", { name: new RegExp(person.name) }));
    await userEvent.click(screen.getByRole("button", { name: /Assign 61,000 to/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Narrow the selection: up to 50,000 leads at a time.",
    );
  });

  it("says when a filter matched more by the time it ran than the person saw (7B review)", async () => {
    vi.mocked(bulkRunsClient.create).mockResolvedValue(
      ok({
        run: run({
          total: 12410,
          done: 12410,
          skipped: 0,
          skippedBy: {},
          selection: { kind: "filter", total: 12410, expected: 12408 },
        }),
      }),
    );
    island({ count: 12408, all: true });
    await userEvent.click(screen.getByRole("button", { name: /Assign/ }));
    await userEvent.click(screen.getByRole("menuitemradio", { name: new RegExp(person.name) }));
    await userEvent.click(screen.getByRole("button", { name: /Assign 12,408 to/ }));
    expect(await screen.findByText(/12,410 matched by then, not the 12,408 you saw/)).toBeInTheDocument();
  });

  it("7C review: the keyboard follows the island — menus take focus and arrow keys, Esc returns, Stop then Undo get focus", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      vi.mocked(bulkRunsClient.create).mockResolvedValue(
        ok(
          {
            run: run({
              status: "queued",
              done: 0,
              skipped: 0,
              skippedBy: {},
              finishedAt: null,
              canUndo: false,
            }),
          },
          202,
        ),
      );
      vi.mocked(bulkRunsClient.get).mockResolvedValue(ok({ run: run() }));
      island({ count: 12408, all: true });
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      const trigger = screen.getByRole("button", { name: /Assign/ });
      await user.click(trigger);
      const items = screen.getAllByRole("menuitemradio");
      await vi.waitFor(() => expect(items[0]).toHaveFocus());
      await user.keyboard("{ArrowDown}");
      expect(items[1]).toHaveFocus();
      await user.keyboard("{Escape}");
      expect(screen.queryByRole("menu", { name: "Assign to" })).not.toBeInTheDocument();
      expect(trigger).toHaveFocus();
      await user.click(trigger);
      await user.click(screen.getByRole("menuitemradio", { name: new RegExp(person.name) }));
      await user.click(screen.getByRole("button", { name: /Assign 12,408 to/ }));
      const stop = await screen.findByRole("button", { name: "Stop" });
      await vi.waitFor(() => expect(stop).toHaveFocus());
      expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuemax", "12408");
      // Said once the run is queued (set after the request returns): waited for, not assumed.
      await vi.waitFor(() => expect(screen.getByText(/LUME will say when it’s done\./)).toBeInTheDocument());
      await act(async () => void (await vi.advanceTimersByTimeAsync(1100)));
      const undoBtn = await screen.findByRole("button", { name: "Undo" });
      await vi.waitFor(() => expect(undoBtn).toHaveFocus());
    } finally {
      vi.useRealTimers();
    }
  });
});
