import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { leadsClient } from "@/lib/leads/client";
import { notificationsClient } from "@/lib/notifications/client";
import { tasksClient } from "@/lib/tasks/client";
import type { TaskView, TodayView } from "@/lib/tasks/types";
import { todayClient } from "@/lib/today/client";
import type { Tiles } from "@/lib/today/types";
import { Today } from "./Today";

const play = vi.fn();
vi.mock("@/components/feedback/SoundProvider", () => ({ useSound: () => ({ play }) }));
vi.mock("@/lib/tasks/client", () => ({ tasksClient: { today: vi.fn(), done: vi.fn(), snooze: vi.fn() } }));
vi.mock("@/lib/today/client", () => ({ todayClient: { tiles: vi.fn() } }));
vi.mock("@/lib/notifications/client", () => ({ notificationsClient: { readAll: vi.fn() }, READ_EVENT: "x" }));
vi.mock("@/lib/leads/client", () => ({
  leadsClient: { prepareMessage: vi.fn(), confirmMessage: vi.fn(), move: vi.fn() },
}));
vi.mock("@/lib/templates/client", () => ({
  templatesClient: {
    list: vi.fn(async () => ({ ok: true, status: 200, data: { templates: [] } })),
    context: vi.fn(async () => ({ ok: false, status: 403, code: "FORBIDDEN", message: "No" })),
  },
}));
// Log outcome is its own component (and tests); here, only that Today opens it and reads again after.
vi.mock("@/components/calendar/LogOutcome", () => ({
  LogOutcome: ({ meeting, onDone }: { meeting: { title: string }; onDone: () => void }) => (
    <div role="dialog" aria-label={`Log ${meeting.title}`}>
      <button type="button" onClick={onDone}>
        Saved
      </button>
    </div>
  ),
}));
let live: ((n: unknown) => void) | null = null;
vi.mock("@/lib/notifications/stream", () => ({ useStream: (on: (n: unknown) => void) => void (live = on) }));

const ok = <T,>(data: T) => ({ ok: true as const, status: 200, data });
const H = 3_600_000;
const t = (id: string, leadName: string, inHours: number): TaskView => ({
  id,
  leadId: `l-${id}`,
  leadName,
  title: "Follow up",
  note: null,
  dueAt: new Date(Date.now() + inHours * H).toISOString(),
  status: "open",
  remindMinutes: [0],
  recurrence: null,
  assignee: { id: "u-me", name: "Maya Kapoor" },
  createdBy: null,
  doneAt: null,
  canEdit: true,
});
const view = (over: Partial<TodayView> = {}): TodayView => ({
  overdue: [t("a", "Aisha Khan", -26)],
  soon: [t("b", "Omar Ali", 1)],
  later: [t("c", "Sara Pinto", 3)],
  done: 2,
  total: 5,
  ...over,
});
const TILES: Tiles = {
  leads: {
    day: "2026-10-05",
    hourNow: 11,
    today: 40,
    lastWeek: 33,
    hours: Array<number>(24).fill(0),
    usual: null,
    weeks: 0,
    reached: 34,
    medianMinutes: 9,
  },
  calendar: {
    weekStart: "2026-10-05",
    todayIndex: 0,
    week: [5, 4, 3, 4, 2, 1, 0],
    today: 5,
    held: 1,
    connected: true,
  },
};
const upNext = () => screen.getByRole("list", { name: "Up next" });

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  vi.mocked(notificationsClient.readAll).mockResolvedValue(ok({ unread: 0 }));
  vi.mocked(todayClient.tiles).mockResolvedValue(ok(TILES));
});
const show = (p: { canMessage?: boolean; canSetUp?: boolean } = {}) =>
  render(<Today name="Maya Kapoor" tz="Asia/Dubai" currency="INR" {...p} />);

describe("Today, the control centre", () => {
  it("greets, says whom to start with, and lists the day's work in order", async () => {
    vi.mocked(tasksClient.today).mockResolvedValue(ok(view()));
    show();
    expect(await screen.findByRole("heading", { level: 1 })).toHaveTextContent(
      /^Good (morning|afternoon|evening), Maya$/,
    );
    // LUME's line: the oldest overdue first, as a link to the lead.
    expect(screen.getByRole("link", { name: "Aisha Khan" })).toHaveAttribute("href", "/leads?lead=l-a");
    expect(screen.getByText(/^, waiting since/)).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "2 of 5 follow-ups due today done" })).toBeInTheDocument();
    expect(
      within(upNext())
        .getAllByRole("listitem")
        .map((li) => within(li).getAllByRole("link")[0]!.textContent),
    ).toEqual(["Aisha KhanFollow up", "Omar AliFollow up", "Sara PintoFollow up"]);
    expect(notificationsClient.readAll).not.toHaveBeenCalled(); // the notification centre does the reading (3B)
  });

  it("every minute the day's work is read again, not only the tiles, so what's overdue stays true (Phase 9 review)", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      vi.mocked(tasksClient.today).mockResolvedValue(ok(view()));
      show();
      await vi.waitFor(() => expect(tasksClient.today).toHaveBeenCalledTimes(1));
      await act(async () => void (await vi.advanceTimersByTimeAsync(60_000)));
      expect(tasksClient.today).toHaveBeenCalledTimes(2);
      expect(todayClient.tiles).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("done takes the row away, moves the ring and plays done", async () => {
    vi.mocked(tasksClient.today).mockResolvedValue(ok(view()));
    vi.mocked(tasksClient.done).mockResolvedValue(
      ok({ task: { ...t("b", "Omar Ali", 1), status: "done" }, next: null, clearedToday: false }),
    );
    show();
    await userEvent.click(await screen.findByRole("button", { name: "Done: Follow up — Omar Ali" }));
    expect(tasksClient.done).toHaveBeenCalledWith("b");
    expect(play).toHaveBeenCalledWith("done");
    await vi.waitFor(() => expect(within(upNext()).queryByText("Omar Ali")).not.toBeInTheDocument());
    expect(screen.getByRole("img", { name: "3 of 5 follow-ups due today done" })).toBeInTheDocument();
  });

  it("WhatsApp from a row: the follow-up rides along, and Sent completes it — the row leaves", async () => {
    vi.mocked(tasksClient.today).mockResolvedValue(ok(view()));
    const tab = { location: { href: "" }, close: vi.fn(), opener: {} as unknown };
    vi.spyOn(window, "open").mockReturnValue(tab as unknown as Window);
    vi.mocked(leadsClient.prepareMessage).mockResolvedValue(ok({ url: "https://wa.me/1" }));
    vi.mocked(leadsClient.confirmMessage).mockResolvedValue(ok({ moved: null }));
    show({ canMessage: true });
    await userEvent.click(await screen.findByRole("button", { name: "WhatsApp Omar Ali" }));
    const sheet = screen.getByRole("dialog", { name: "WhatsApp Omar Ali" });
    await within(sheet).findByRole("option", { name: "Write your own" });
    await userEvent.type(within(sheet).getByRole("textbox", { name: "Message" }), "Hi Omar");
    await userEvent.click(within(sheet).getByRole("button", { name: "Open WhatsApp" }));
    expect(leadsClient.prepareMessage).toHaveBeenCalledWith("l-b", "Hi Omar", { taskId: "b" });
    window.dispatchEvent(new Event("focus"));
    // The server completes the follow-up with the send: Today, asked again, no longer has it.
    vi.mocked(tasksClient.today).mockResolvedValue(ok(view({ soon: [], done: 3 })));
    await userEvent.click(await screen.findByRole("button", { name: "Yes, sent" }));
    expect(leadsClient.confirmMessage).toHaveBeenCalledWith("l-b", true, "b");
    expect(play).toHaveBeenCalledWith("sent");
    await vi.waitFor(() => expect(within(upNext()).queryByText("Omar Ali")).not.toBeInTheDocument(), {
      timeout: 4000,
    });
  });

  it("no WhatsApp on the rows for someone who can't send messages", async () => {
    vi.mocked(tasksClient.today).mockResolvedValue(ok(view()));
    show();
    await screen.findByRole("list", { name: "Up next" });
    expect(screen.queryByRole("button", { name: /^WhatsApp / })).not.toBeInTheDocument();
  });

  it("the day's last one done: All clear, and the cleared sound once — not again the same day", async () => {
    const one = view({ overdue: [], soon: [t("b", "Omar Ali", 1)], later: [], done: 4, total: 5 });
    vi.mocked(tasksClient.today).mockResolvedValue(ok(one));
    vi.mocked(tasksClient.done).mockResolvedValue(
      ok({ task: { ...t("b", "Omar Ali", 1), status: "done" }, next: null, clearedToday: true }),
    );
    const { unmount } = show();
    await userEvent.click(await screen.findByRole("button", { name: "Done: Follow up — Omar Ali" }));
    expect(await screen.findByRole("heading", { name: "All clear" })).toBeInTheDocument();
    expect(play).toHaveBeenCalledWith("cleared");
    unmount();
    play.mockClear();
    vi.mocked(tasksClient.today).mockResolvedValue(
      ok(view({ overdue: [], soon: [], later: [], done: 5, total: 5 })),
    );
    show();
    expect(await screen.findByRole("heading", { name: "All clear" })).toBeInTheDocument();
    expect(play).not.toHaveBeenCalled();
  });

  it("Important 8: opening Today on a day already cleared shows All clear, silently", async () => {
    vi.mocked(tasksClient.today).mockResolvedValue(
      ok(view({ overdue: [], soon: [], later: [], done: 5, total: 5 })),
    );
    show();
    expect(await screen.findByRole("heading", { name: "All clear" })).toBeInTheDocument();
    expect(play).not.toHaveBeenCalled(); // sounds follow actions, never a page opening
  });

  it("Important 7: done on a repeating one that's due again today isn't All clear", async () => {
    const one = view({ overdue: [t("a", "Aisha Khan", -14)], soon: [], later: [], done: 0, total: 1 });
    const again = view({ overdue: [], soon: [], later: [t("n", "Aisha Khan", 10)], done: 1, total: 2 });
    vi.mocked(tasksClient.today).mockResolvedValueOnce(ok(one)).mockResolvedValue(ok(again));
    vi.mocked(tasksClient.done).mockResolvedValue(
      ok({
        task: { ...t("a", "Aisha Khan", -14), status: "done" },
        next: t("n", "Aisha Khan", 10),
        clearedToday: false,
      }),
    );
    show();
    await userEvent.click(await screen.findByRole("button", { name: "Done: Follow up — Aisha Khan" }));
    await vi.waitFor(() => expect(tasksClient.today).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole("button", { name: "Done: Follow up — Aisha Khan" })).toBeEnabled();
    expect(screen.queryByRole("heading", { name: "All clear" })).not.toBeInTheDocument();
    expect(play).toHaveBeenCalledWith("done");
    expect(play).not.toHaveBeenCalledWith("cleared");
  });

  it("nothing due today is a calm empty day, not a celebration", async () => {
    vi.mocked(tasksClient.today).mockResolvedValue(
      ok(view({ overdue: [], soon: [], later: [], done: 0, total: 0 })),
    );
    show();
    expect(await screen.findByText("Nothing is due today.")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "All clear" })).not.toBeInTheDocument();
    expect(play).not.toHaveBeenCalled();
  });

  it("a business with no leads yet shows whoever sets LUME up the first steps", async () => {
    vi.mocked(tasksClient.today).mockResolvedValue(
      ok(view({ overdue: [], soon: [], later: [], done: 0, total: 0 })),
    );
    vi.mocked(todayClient.tiles).mockResolvedValue(
      ok({
        ...TILES,
        leads: { ...TILES.leads!, today: 0 },
        pipeline: {
          name: "Sales",
          many: false,
          open: 0,
          openEverywhere: null,
          stages: [],
          wonThisMonth: 0,
          forecast: null,
        },
      }),
    );
    show({ canSetUp: true });
    const steps = await screen.findByRole("list", { name: "Get LUME ready" });
    expect(within(steps).getByRole("link", { name: "Import" })).toHaveAttribute("href", "/settings/imports");
  });

  it("a live notification brings the work up to date", async () => {
    vi.mocked(tasksClient.today).mockResolvedValue(ok(view()));
    show();
    await screen.findByRole("list", { name: "Up next" });
    expect(tasksClient.today).toHaveBeenCalledTimes(1);
    await act(async () => live?.({ id: 9, kind: "follow_up_due", title: "Follow up — Omar Ali" }));
    await vi.waitFor(() => expect(tasksClient.today).toHaveBeenCalledTimes(2));
  });

  it("admins see what needs them, each with its one action", async () => {
    vi.mocked(tasksClient.today).mockResolvedValue(
      ok(
        view({
          needsYou: {
            unassigned: 3,
            unassignedOldest: new Date(Date.now() - 2 * H).toISOString(),
            sources: [{ id: "s1", name: "Website enquiries", type: "google_sheet" }],
          },
        }),
      ),
    );
    show();
    await userEvent.click(await screen.findByRole("button", { name: "Needs you, 2" }));
    const pop = screen.getByRole("dialog", { name: "Needs you" });
    expect(pop).toHaveTextContent("3 new leads have no one yet");
    expect(pop).toHaveTextContent("The oldest came in 2 hours ago");
    // It opens Leads filtered to nobody's: the list reads `owner`, not `ownerId` (owner, 2026-10-05).
    expect(within(pop).getByRole("link", { name: "Assign" })).toHaveAttribute("href", "/leads?owner=none");
    expect(within(pop).getByRole("link", { name: "Fix" })).toHaveAttribute(
      "href",
      "/settings/integrations/s1",
    );
  });

  it("someone with nothing to unblock sees no Needs you; an admin with nothing to do reads All good", async () => {
    vi.mocked(tasksClient.today).mockResolvedValue(ok(view()));
    const { unmount } = show();
    await screen.findByRole("list", { name: "Up next" });
    expect(screen.queryByRole("button", { name: /Needs you/ })).not.toBeInTheDocument();
    unmount();
    vi.mocked(tasksClient.today).mockResolvedValue(ok(view({ needsYou: { unassigned: 0, sources: [] } })));
    show();
    expect(await screen.findByRole("button", { name: "Nothing needs you" })).toBeDisabled();
  });

  it("the tiles load beside the work; if they can't, Today says so and offers to try again", async () => {
    vi.mocked(tasksClient.today).mockResolvedValue(ok(view()));
    vi.mocked(todayClient.tiles).mockResolvedValueOnce({
      ok: false,
      status: 500,
      code: "X",
      message: "No",
    } as never);
    show();
    await userEvent.click(await screen.findByRole("button", { name: "Try again" }));
    const region = screen.getByRole("region", { name: "How it's going" });
    expect(await within(region).findByRole("link", { name: /^Leads: 40 new today/ })).toHaveAttribute(
      "href",
      "/leads",
    );
  });

  it("each row's Snooze says whose follow-up it is (not five buttons all called Snooze)", async () => {
    vi.mocked(tasksClient.today).mockResolvedValue(ok(view()));
    show();
    const snoozes = await screen.findAllByRole("button", { name: /^Snooze/ });
    const names = snoozes.map((b) => b.getAttribute("aria-label") ?? b.textContent);
    expect(new Set(names).size).toBe(names.length);
    expect(names.every((n) => /^Snooze .+ — .+/.test(n ?? ""))).toBe(true);
  });

  it("5D Task 11: a call that ended is owed its outcome in Up next; logging it reads Today again", async () => {
    const ended = new Date(Date.now() - 2 * H);
    vi.mocked(tasksClient.today).mockResolvedValue(
      ok(
        view({
          meetings: [
            {
              id: "m1",
              title: "Pricing walkthrough",
              startsAt: ended.toISOString(),
              endsAt: new Date(ended.getTime() + H / 2).toISOString(),
              link: null,
              status: "scheduled",
              lead: { id: "l-k", name: "Karim Aziz" },
              matchedBy: "attendee",
              reminder: null,
            },
          ],
        }),
      ),
    );
    show();
    const list = await screen.findByRole("list", { name: "Up next" });
    await userEvent.click(within(list).getByRole("button", { name: "Log outcome" }));
    const dialog = screen.getByRole("dialog", { name: "Log Pricing walkthrough" });
    expect(tasksClient.today).toHaveBeenCalledTimes(1);
    await userEvent.click(within(dialog).getByRole("button", { name: "Saved" }));
    expect(screen.queryByRole("dialog", { name: "Log Pricing walkthrough" })).not.toBeInTheDocument();
    expect(tasksClient.today).toHaveBeenCalledTimes(2);
  });
});
