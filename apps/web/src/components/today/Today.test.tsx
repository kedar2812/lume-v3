import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { leadsClient } from "@/lib/leads/client";
import { notificationsClient } from "@/lib/notifications/client";
import { tasksClient } from "@/lib/tasks/client";
import type { TaskView, TodayView } from "@/lib/tasks/types";
import { Today } from "./Today";

const play = vi.fn();
vi.mock("@/components/feedback/SoundProvider", () => ({ useSound: () => ({ play }) }));
vi.mock("@/lib/tasks/client", () => ({ tasksClient: { today: vi.fn(), done: vi.fn(), snooze: vi.fn() } }));
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

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  vi.mocked(notificationsClient.readAll).mockResolvedValue(ok({ unread: 0 }));
});

describe("Today", () => {
  it("greets, names who to start with, and shows the day's progress and groups", async () => {
    vi.mocked(tasksClient.today).mockResolvedValue(ok(view()));
    render(<Today name="Maya Kapoor" tz="Asia/Dubai" />);
    expect(await screen.findByRole("heading", { level: 1 })).toHaveTextContent(
      /^Good (morning|afternoon|evening), Maya$/,
    );
    expect(screen.getByText(/Aisha Khan has been waiting since/)).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "2 of 5 cleared today" })).toBeInTheDocument();
    const overdue = screen.getByRole("list", { name: "Overdue" });
    expect(within(overdue).getByRole("link", { name: "Aisha Khan" })).toHaveAttribute(
      "href",
      "/leads?lead=l-a",
    );
    expect(screen.getByRole("list", { name: "Due soon" })).toHaveTextContent("Omar Ali");
    expect(screen.getByRole("list", { name: "Later today" })).toHaveTextContent("Sara Pinto");
    expect(notificationsClient.readAll).not.toHaveBeenCalled(); // the notification centre does the reading (3B)
  });

  it("done takes the row away, moves the ring, and plays done", async () => {
    vi.mocked(tasksClient.today).mockResolvedValue(ok(view()));
    vi.mocked(tasksClient.done).mockResolvedValue(
      ok({ task: { ...t("b", "Omar Ali", 1), status: "done" }, next: null, clearedToday: false }),
    );
    render(<Today name="Maya Kapoor" tz="Asia/Dubai" />);
    await userEvent.click(await screen.findByRole("button", { name: "Done: Follow up — Omar Ali" }));
    expect(tasksClient.done).toHaveBeenCalledWith("b");
    expect(play).toHaveBeenCalledWith("done");
    await vi.waitFor(() => expect(screen.queryByRole("list", { name: "Due soon" })).not.toBeInTheDocument());
    expect(screen.getByRole("img", { name: "3 of 5 cleared today" })).toBeInTheDocument();
  });

  it("WhatsApp from a row: the follow-up rides along, and Sent completes it — the row leaves", async () => {
    vi.mocked(tasksClient.today).mockResolvedValue(ok(view()));
    const tab = { location: { href: "" }, close: vi.fn(), opener: {} as unknown };
    vi.spyOn(window, "open").mockReturnValue(tab as unknown as Window);
    vi.mocked(leadsClient.prepareMessage).mockResolvedValue(ok({ url: "https://wa.me/1" }));
    vi.mocked(leadsClient.confirmMessage).mockResolvedValue(ok({ moved: null }));
    render(<Today name="Maya Kapoor" tz="Asia/Dubai" canMessage />);
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
    await vi.waitFor(() => expect(screen.queryByRole("list", { name: "Due soon" })).not.toBeInTheDocument(), {
      timeout: 4000,
    });
    expect(screen.getByRole("img", { name: "3 of 5 cleared today" })).toBeInTheDocument();
  });

  it("no WhatsApp on the rows for someone who can't send messages", async () => {
    vi.mocked(tasksClient.today).mockResolvedValue(ok(view()));
    render(<Today name="Maya Kapoor" tz="Asia/Dubai" />);
    await screen.findByRole("list", { name: "Due soon" });
    expect(screen.queryByRole("button", { name: /^WhatsApp / })).not.toBeInTheDocument();
  });

  it("the day's last one done: All clear, and the cleared sound once — not again the same day", async () => {
    const one = view({ overdue: [], soon: [t("b", "Omar Ali", 1)], later: [], done: 4, total: 5 });
    vi.mocked(tasksClient.today).mockResolvedValue(ok(one));
    vi.mocked(tasksClient.done).mockResolvedValue(
      ok({ task: { ...t("b", "Omar Ali", 1), status: "done" }, next: null, clearedToday: true }),
    );
    const { unmount } = render(<Today name="Maya Kapoor" tz="Asia/Dubai" />);
    await userEvent.click(await screen.findByRole("button", { name: "Done: Follow up — Omar Ali" }));
    expect(await screen.findByRole("heading", { name: "All clear" })).toBeInTheDocument();
    expect(play).toHaveBeenCalledWith("cleared");
    unmount();
    play.mockClear();
    vi.mocked(tasksClient.today).mockResolvedValue(
      ok(view({ overdue: [], soon: [], later: [], done: 5, total: 5 })),
    );
    render(<Today name="Maya Kapoor" tz="Asia/Dubai" />);
    expect(await screen.findByRole("heading", { name: "All clear" })).toBeInTheDocument();
    expect(play).not.toHaveBeenCalled();
  });

  it("Important 8: opening Today on a day already cleared shows All clear, silently", async () => {
    vi.mocked(tasksClient.today).mockResolvedValue(
      ok(view({ overdue: [], soon: [], later: [], done: 5, total: 5 })),
    );
    render(<Today name="Maya Kapoor" tz="Asia/Dubai" />);
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
    render(<Today name="Maya Kapoor" tz="Asia/Dubai" />);
    await userEvent.click(await screen.findByRole("button", { name: "Done: Follow up — Aisha Khan" }));
    expect(await screen.findByRole("list", { name: "Later today" })).toHaveTextContent("Aisha Khan");
    expect(screen.queryByRole("heading", { name: "All clear" })).not.toBeInTheDocument();
    expect(play).toHaveBeenCalledWith("done");
    expect(play).not.toHaveBeenCalledWith("cleared");
  });

  it("nothing due today is a calm empty day, not a celebration", async () => {
    vi.mocked(tasksClient.today).mockResolvedValue(
      ok(view({ overdue: [], soon: [], later: [], done: 0, total: 0 })),
    );
    render(<Today name="Maya Kapoor" tz="Asia/Dubai" />);
    expect(await screen.findByText("Nothing's due today.")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "All clear" })).not.toBeInTheDocument();
    expect(play).not.toHaveBeenCalled();
  });

  it("a live notification brings the list up to date", async () => {
    vi.mocked(tasksClient.today).mockResolvedValue(ok(view()));
    render(<Today name="Maya Kapoor" tz="Asia/Dubai" />);
    await screen.findByRole("list", { name: "Overdue" });
    expect(tasksClient.today).toHaveBeenCalledTimes(1);
    await act(async () => live?.({ id: 9, kind: "follow_up_due", title: "Follow up — Omar Ali" }));
    await vi.waitFor(() => expect(tasksClient.today).toHaveBeenCalledTimes(2));
  });

  it("admins also see what needs them", async () => {
    vi.mocked(tasksClient.today).mockResolvedValue(
      ok(
        view({
          needsYou: {
            unassigned: 3,
            sources: [{ id: "s1", name: "Website enquiries", type: "google_sheet" }],
          },
        }),
      ),
    );
    render(<Today name="Maya Kapoor" tz="Asia/Dubai" />);
    expect(await screen.findByRole("link", { name: /3 new leads have no one yet/ })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Website enquiries needs attention/ })).toHaveAttribute(
      "href",
      "/settings/integrations/s1",
    );
  });

  it("each row's Snooze says whose follow-up it is (not five buttons all called Snooze)", async () => {
    vi.mocked(tasksClient.today).mockResolvedValue(ok(view()));
    render(<Today name="Maya Kapoor" tz="Asia/Dubai" />);
    const snoozes = await screen.findAllByRole("button", { name: /^Snooze/ });
    const names = snoozes.map((b) => b.getAttribute("aria-label") ?? b.textContent);
    expect(new Set(names).size).toBe(names.length);
    expect(names.every((n) => /^Snooze .+ — .+/.test(n ?? ""))).toBe(true);
  });

  it("5D Task 11: a call that ended opens Log outcome right here, and Today reads again once it's saved", async () => {
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
    render(<Today name="Maya Kapoor" tz="Asia/Dubai" />);
    const calls = await screen.findByRole("region", { name: "Today's calls" });
    await userEvent.click(within(calls).getByRole("button", { name: "Log outcome" }));
    const dialog = screen.getByRole("dialog", { name: "Log Pricing walkthrough" });
    expect(tasksClient.today).toHaveBeenCalledTimes(1);
    await userEvent.click(within(dialog).getByRole("button", { name: "Saved" }));
    expect(screen.queryByRole("dialog", { name: "Log Pricing walkthrough" })).not.toBeInTheDocument();
    expect(tasksClient.today).toHaveBeenCalledTimes(2);
  });
});
