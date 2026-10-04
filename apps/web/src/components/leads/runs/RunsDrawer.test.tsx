import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { bulkRunsClient, type RunView } from "@/lib/leads/bulk-runs";
import { testCatalog } from "@/lib/leads/test-catalog";
import { fakeSession, type Session } from "@/server/session";
import { CatalogProvider } from "../CatalogProvider";
import { RunsDrawer } from "./RunsDrawer";

vi.mock("@/lib/leads/bulk-runs", async (orig) => {
  const real = await orig<typeof import("@/lib/leads/bulk-runs")>();
  return {
    ...real,
    bulkRunsClient: { create: vi.fn(), get: vi.fn(), list: vi.fn(), cancel: vi.fn(), undo: vi.fn() },
  };
});
const toast = vi.fn();
vi.mock("@/components/feedback/ToastProvider", () => ({ useToast: () => ({ toast, dismiss: vi.fn() }) }));

const ME = "00000000-0000-7000-8000-000000000001";
const catalog = testCatalog();
const other = catalog.people.find((p) => p.id !== ME)!;
const mk = (over: Partial<RunView>): RunView => ({
  id: "r1",
  userId: ME,
  action: { type: "delete" },
  selection: { kind: "ids", total: 40 },
  status: "done",
  total: 40,
  done: 40,
  skipped: 0,
  failed: 0,
  skippedBy: {},
  error: null,
  createdAt: new Date().toISOString(),
  startedAt: new Date().toISOString(),
  finishedAt: new Date().toISOString(),
  undoOf: null,
  undoUntil: new Date(Date.now() + 20 * 3_600_000).toISOString(),
  canUndo: true,
  ...over,
});
const runs: RunView[] = [
  mk({ id: "r1", action: { type: "delete" }, done: 38, skipped: 2, skippedBy: { CHANGED_SINCE: 2 } }),
  mk({
    id: "r2",
    userId: other.id,
    action: { type: "delete" },
    done: 7,
    total: 7,
    canUndo: false,
    undoUntil: null,
  }),
];
const admin = () =>
  fakeSession({
    permissions: [
      { key: "leads.view", scope: "all" },
      { key: "leads.bulk_edit", scope: "all" },
    ],
  });
const rep = () =>
  fakeSession({
    permissions: [
      { key: "leads.view", scope: "own" },
      { key: "leads.bulk_edit", scope: "own" },
    ],
  });
const drawer = (session: Session) => {
  const onChanged = vi.fn();
  render(
    <CatalogProvider catalog={catalog}>
      <RunsDrawer session={session} onClose={vi.fn()} onChanged={onChanged} />
    </CatalogProvider>,
  );
  return { onChanged };
};

beforeEach(() => {
  vi.mocked(bulkRunsClient.list).mockReset().mockResolvedValue({ ok: true, status: 200, data: { runs } });
  vi.mocked(bulkRunsClient.undo).mockReset();
  toast.mockReset();
});

describe("recent bulk actions (7C)", () => {
  it("lists my runs from today, opens one to show why leads were skipped, and undoes it", async () => {
    vi.mocked(bulkRunsClient.undo).mockResolvedValue({ ok: true, status: 200, data: { run: runs[0]! } });
    const { onChanged } = drawer(admin());
    const dialog = await screen.findByRole("dialog", { name: "Recent bulk actions" });
    expect(dialog.parentElement?.parentElement).toBe(document.body); // on the full-window scrim
    expect(within(dialog).getByRole("heading", { name: "Today" })).toBeInTheDocument();
    expect(within(dialog).getByText("38 leads deleted")).toBeInTheDocument();
    expect(within(dialog).queryByText("7 leads deleted")).not.toBeInTheDocument(); // someone else's, under Everyone's
    const row = within(dialog).getByRole("button", { name: /38 leads deleted/ });
    await userEvent.click(row);
    expect(row).toHaveAttribute("aria-expanded", "true");
    expect(within(dialog).getByText(/2 were changed by someone after the action/)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "Undo" }));
    expect(bulkRunsClient.undo).toHaveBeenCalledWith("r1");
    await vi.waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
  });

  it("Everyone's shows other people's runs to someone with bulk edits over all leads, and isn't offered to a rep", async () => {
    drawer(admin());
    await userEvent.click(await screen.findByRole("radio", { name: "Everyone’s" }));
    expect(screen.getByText("7 leads deleted")).toBeInTheDocument();
    expect(screen.getByText(new RegExp(`${other.name} ·`))).toBeInTheDocument();
  });

  it("a rep sees only their own, with no Everyone's", async () => {
    drawer(rep());
    expect(await screen.findByText("38 leads deleted")).toBeInTheDocument();
    expect(screen.queryByRole("radio", { name: "Everyone’s" })).not.toBeInTheDocument();
  });

  it("a refused undo is said in LUME's words", async () => {
    vi.mocked(bulkRunsClient.undo).mockResolvedValue({
      ok: false,
      status: 409,
      code: "UNDO_EXPIRED",
      message: "The 24 hours to undo this have passed.",
    });
    drawer(admin());
    await userEvent.click(await screen.findByRole("button", { name: /38 leads deleted/ }));
    await userEvent.click(screen.getByRole("button", { name: "Undo" }));
    await vi.waitFor(() =>
      expect(toast).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "LUME couldn’t undo that",
          detail: "The 24 hours to undo this have passed.",
        }),
      ),
    );
  });

  it("7C review: focus moves into the drawer; collapsed rows keep their buttons out of reach; a run that finishes refreshes the list", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const going = mk({
        id: "live1",
        status: "running",
        done: 2,
        total: 7,
        canUndo: false,
        undoUntil: null,
        finishedAt: null,
      });
      vi.mocked(bulkRunsClient.list)
        .mockResolvedValueOnce({ ok: true, status: 200, data: { runs: [going, ...runs] } })
        .mockResolvedValue({
          ok: true,
          status: 200,
          data: { runs: [{ ...going, status: "done", done: 7 }, ...runs] },
        });
      const { onChanged } = drawer(admin());
      const dialog = await screen.findByRole("dialog", { name: "Recent bulk actions" });
      expect(dialog).toContainElement(document.activeElement as HTMLElement);
      expect(screen.queryByRole("button", { name: "Undo" })).not.toBeInTheDocument(); // collapsed: hidden
      expect(onChanged).not.toHaveBeenCalled();
      await act(async () => void (await vi.advanceTimersByTimeAsync(2100)));
      expect(onChanged).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
