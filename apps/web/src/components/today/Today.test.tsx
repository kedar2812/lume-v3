import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { notificationsClient } from "@/lib/notifications/client";
import { tasksClient } from "@/lib/tasks/client";
import type { TaskView, TodayView } from "@/lib/tasks/types";
import { Today } from "./Today";

const play = vi.fn();
vi.mock("@/components/feedback/SoundProvider", () => ({ useSound: () => ({ play }) }));
vi.mock("@/lib/tasks/client", () => ({ tasksClient: { today: vi.fn(), done: vi.fn(), snooze: vi.fn() } }));
vi.mock("@/lib/notifications/client", () => ({ notificationsClient: { readAll: vi.fn() }, READ_EVENT: "x" }));
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
    expect(notificationsClient.readAll).toHaveBeenCalled(); // opening Today reads what the bell was holding
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
});
