import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { leadsClient } from "@/lib/leads/client";
import { notificationsClient, sayUnread, type NotificationView } from "@/lib/notifications/client";
import { tasksClient } from "@/lib/tasks/client";
import type { TaskView, TodayView } from "@/lib/tasks/types";
import { NotificationCentre } from "./NotificationCentre";

const play = vi.fn();
const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
vi.mock("@/components/feedback/SoundProvider", () => ({ useSound: () => ({ play }) }));
vi.mock("@/lib/tasks/client", () => ({
  tasksClient: { today: vi.fn(), done: vi.fn(), snooze: vi.fn(), nudge: vi.fn() },
}));
vi.mock("@/lib/notifications/client", () => ({
  notificationsClient: { list: vi.fn(), read: vi.fn(), readAll: vi.fn() },
  sayUnread: vi.fn(),
  READ_EVENT: "lume:notifications-read",
}));
vi.mock("@/lib/leads/client", () => ({
  leadsClient: { prepareMessage: vi.fn(), confirmMessage: vi.fn(), move: vi.fn() },
}));
vi.mock("@/lib/templates/client", () => ({
  templatesClient: {
    list: vi.fn(async () => ({ ok: true, status: 200, data: { templates: [] } })),
    context: vi.fn(async () => ({ ok: false, status: 403, code: "FORBIDDEN", message: "No" })),
  },
}));
let live: ((n: unknown) => void) | null = null;
vi.mock("@/lib/notifications/stream", () => ({ useStream: (on: (n: unknown) => void) => void (live = on) }));

const ok = <T,>(data: T) => ({ ok: true as const, status: 200, data });
const H = 3_600_000;
const task = (id: string, leadName: string, inHours: number): TaskView => ({
  id,
  leadId: `l-${id}`,
  leadName,
  title: "Call back",
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
const note = (
  id: number,
  kind: string,
  title: string,
  over: Partial<NotificationView> = {},
): NotificationView => ({
  id,
  kind,
  title,
  body: null,
  leadId: "l-x",
  taskId: null,
  createdAt: new Date().toISOString(),
  read: false,
  ...over,
});
const today = (over: Partial<TodayView> = {}): TodayView => ({
  overdue: [task("a", "Aisha Khan", -3)],
  soon: [task("b", "Omar Ali", 0.5)],
  later: [task("c", "Sara Pinto", 4)],
  done: 0,
  total: 3,
  ...over,
});
const updates = [
  note(3, "task_escalated", "Riya's follow-up with Aisha Khan is 26 h overdue", {
    taskId: "t-riya",
    leadId: "l-aisha",
  }),
  note(2, "lead_assigned", "Karim Aziz was assigned to you by Leila", { leadId: "l-karim", read: true }),
];

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(tasksClient.today).mockResolvedValue(ok(today()));
  vi.mocked(notificationsClient.list).mockResolvedValue(ok({ items: updates, unread: 1 }));
  vi.mocked(notificationsClient.read).mockResolvedValue(ok({ unread: 0 }));
  vi.mocked(notificationsClient.readAll).mockResolvedValue(ok({ unread: 0 }));
});
afterEach(() => vi.useRealTimers());

const open = async () => {
  const onClose = vi.fn();
  render(<NotificationCentre open onClose={onClose} />);
  await screen.findByRole("dialog", { name: "Notifications" });
  await screen.findByRole("list", { name: "Overdue" });
  return onClose;
};

describe("the notification centre (3B Task 5)", () => {
  it("groups what needs you — Overdue, Due now, Later today — and Updates", async () => {
    await open();
    expect(screen.getByRole("list", { name: "Overdue" })).toHaveTextContent("Aisha Khan");
    expect(screen.getByRole("list", { name: "Due now" })).toHaveTextContent("Omar Ali");
    expect(screen.getByRole("list", { name: "Later today" })).toHaveTextContent("Sara Pinto");
    expect(screen.getByRole("list", { name: "Updates" })).toHaveTextContent("Karim Aziz was assigned");
  });

  it("filters: Needs you keeps follow-ups and escalations; Updates keeps the rest", async () => {
    await open();
    await userEvent.click(screen.getByRole("radio", { name: "Updates" }));
    await vi.waitFor(() => expect(screen.queryByRole("list", { name: "Overdue" })).not.toBeInTheDocument());
    expect(screen.getByText(/Karim Aziz was assigned/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("radio", { name: "Needs you" }));
    expect(screen.getByRole("list", { name: "Overdue" })).toBeInTheDocument();
    expect(screen.getByText(/26 h overdue/)).toBeInTheDocument();
    // It leaves with its exit animation, then it's gone.
    await vi.waitFor(() => expect(screen.queryByText(/Karim Aziz was assigned/)).not.toBeInTheDocument());
  });

  it("an unread one is read after 600 ms under the pointer, not before", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await open();
    const item = screen.getByRole("listitem", { name: /26 h overdue/ });
    await user.hover(item);
    await act(async () => void (await vi.advanceTimersByTimeAsync(400)));
    expect(notificationsClient.read).not.toHaveBeenCalled();
    await act(async () => void (await vi.advanceTimersByTimeAsync(300)));
    expect(notificationsClient.read).toHaveBeenCalledWith([3]);
  });

  it("Mark all read", async () => {
    await open();
    await userEvent.click(screen.getByRole("button", { name: "Mark all read" }));
    expect(notificationsClient.readAll).toHaveBeenCalled();
  });

  it("done from the centre plays done and takes it away; Remind them nudges the assignee", async () => {
    vi.mocked(tasksClient.done).mockResolvedValue(
      ok({ task: { ...task("a", "Aisha Khan", -3), status: "done" }, next: null, clearedToday: false }),
    );
    vi.mocked(tasksClient.nudge).mockResolvedValue(ok({ reminded: true }) as never);
    await open();
    const overdue = screen.getByRole("list", { name: "Overdue" });
    await userEvent.click(within(overdue).getByRole("button", { name: "Done" }));
    expect(tasksClient.done).toHaveBeenCalledWith("a");
    expect(play).toHaveBeenCalledWith("done");
    await userEvent.click(screen.getByRole("button", { name: "Remind them" }));
    expect(tasksClient.nudge).toHaveBeenCalledWith("t-riya");
    expect(await screen.findByText("Reminded")).toBeInTheDocument();
  });

  it("WhatsApp from a follow-up: it rides along, and Sent completes it (4A)", async () => {
    const tab = { location: { href: "" }, close: vi.fn(), opener: {} as unknown };
    vi.spyOn(window, "open").mockReturnValue(tab as unknown as Window);
    vi.mocked(leadsClient.prepareMessage).mockResolvedValue(ok({ url: "https://wa.me/1" }));
    vi.mocked(leadsClient.confirmMessage).mockResolvedValue(ok({ moved: null }));
    render(<NotificationCentre open onClose={vi.fn()} canMessage />);
    await userEvent.click(await screen.findByRole("button", { name: "WhatsApp Omar Ali" }));
    const sheet = screen.getByRole("dialog", { name: "WhatsApp Omar Ali" });
    await within(sheet).findByRole("option", { name: "Write your own" });
    await userEvent.type(within(sheet).getByRole("textbox", { name: "Message" }), "Hi Omar");
    await userEvent.click(within(sheet).getByRole("button", { name: "Open WhatsApp" }));
    expect(leadsClient.prepareMessage).toHaveBeenCalledWith("l-b", "Hi Omar", { taskId: "b" });
    window.dispatchEvent(new Event("focus"));
    vi.mocked(tasksClient.today).mockResolvedValue(ok(today({ soon: [], done: 1 })));
    await userEvent.click(await screen.findByRole("button", { name: "Yes, sent" }));
    expect(leadsClient.confirmMessage).toHaveBeenCalledWith("l-b", true, "b");
    expect(play).toHaveBeenCalledWith("sent");
    await vi.waitFor(() => expect(screen.queryByText("Omar Ali")).not.toBeInTheDocument(), { timeout: 4000 });
  });

  it("a row's send sheet keeps its own keys: E there doesn't finish the follow-up", async () => {
    render(<NotificationCentre open onClose={vi.fn()} canMessage />);
    await userEvent.click(await screen.findByRole("button", { name: "WhatsApp Omar Ali" }));
    const list = await screen.findByRole("listbox", { name: "Templates" });
    list.focus();
    await userEvent.keyboard("e");
    expect(tasksClient.done).not.toHaveBeenCalled();
  });

  it("keyboard: J/K move, E finishes, Enter opens the lead", async () => {
    vi.mocked(tasksClient.done).mockResolvedValue(
      ok({ task: { ...task("b", "Omar Ali", 0.5), status: "done" }, next: null, clearedToday: false }),
    );
    await open();
    await userEvent.keyboard("j");
    expect(screen.getByRole("listitem", { name: /^Aisha Khan/ })).toHaveFocus();
    await userEvent.keyboard("j");
    expect(screen.getByRole("listitem", { name: /^Omar Ali/ })).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    expect(push).toHaveBeenCalledWith("/leads?lead=l-b");
    await userEvent.keyboard("e");
    expect(tasksClient.done).toHaveBeenCalledWith("b");
    // Focus goes on to the next row, so E, E, E works down the list.
    await vi.waitFor(() => expect(screen.getByRole("listitem", { name: /^Sara Pinto/ })).toHaveFocus());
    await userEvent.keyboard("k");
    expect(screen.getByRole("listitem", { name: /^Omar Ali/ })).toHaveFocus();
  });

  it("F goes full screen; Esc comes back, then closes", async () => {
    const onClose = await open();
    const dialog = screen.getByRole("dialog", { name: "Notifications" });
    await userEvent.keyboard("f");
    expect(dialog).toHaveAttribute("data-full");
    await userEvent.keyboard("{Escape}");
    expect(dialog).not.toHaveAttribute("data-full");
    expect(onClose).not.toHaveBeenCalled();
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalled();
  });

  it("an arrival while it's open brings it up to date", async () => {
    await open();
    expect(tasksClient.today).toHaveBeenCalledTimes(1);
    await act(async () => live?.(note(9, "lead_assigned", "New one")));
    await vi.waitFor(() => expect(notificationsClient.list).toHaveBeenCalledTimes(2));
  });

  it("times read as people say them: an update is 'ago', and overdue is said once, not twice", async () => {
    vi.mocked(notificationsClient.list).mockResolvedValue(
      ok({
        items: [
          note(3, "task_escalated", "Riya's follow-up with Aisha Khan is 26 h overdue", {
            createdAt: new Date(Date.now() - 5 * 60_000).toISOString(),
          }),
        ],
        unread: 1,
      }),
    );
    await open();
    const update = screen.getByRole("listitem", { name: /26 h overdue/ });
    expect(within(update).getByText("5m ago")).toBeInTheDocument();
    const late = screen.getByRole("listitem", { name: /^Aisha Khan/ });
    expect(late.querySelector("time")?.textContent).not.toMatch(/overdue/);
  });

  it("nothing at all: You're all caught up", async () => {
    vi.mocked(tasksClient.today).mockResolvedValue(ok(today({ overdue: [], soon: [], later: [], total: 0 })));
    vi.mocked(notificationsClient.list).mockResolvedValue(ok({ items: [], unread: 0 }));
    render(<NotificationCentre open onClose={vi.fn()} />);
    expect(await screen.findByText("You're all caught up")).toBeInTheDocument();
  });
});

describe("the notification centre: 3B final review", () => {
  it("Important 3: Open, and Enter, open the lead and step the centre out of its way", async () => {
    const onClose = await open();
    await userEvent.click(
      within(screen.getByRole("list", { name: "Overdue" })).getByRole("button", { name: "Open" }),
    );
    expect(push).toHaveBeenCalledWith("/leads?lead=l-a");
    expect(onClose).toHaveBeenCalledTimes(1);
    await userEvent.keyboard("j");
    await userEvent.keyboard("{Enter}");
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("Important 3: with a lead's drawer in front, its keys are the drawer's", async () => {
    const onClose = vi.fn();
    render(
      <>
        <NotificationCentre open onClose={onClose} />
        <div role="dialog" aria-modal="true" aria-label="Aisha Khan">
          <button type="button">In the drawer</button>
        </div>
      </>,
    );
    await screen.findByRole("list", { name: "Overdue" });
    screen.getByRole("button", { name: "In the drawer" }).focus();
    await userEvent.keyboard("j");
    expect(screen.getByRole("button", { name: "In the drawer" })).toHaveFocus();
    await userEvent.keyboard("f");
    expect(screen.getByRole("dialog", { name: "Notifications" })).not.toHaveAttribute("data-full");
    await userEvent.keyboard("{Escape}");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("Important 4: J from a row's button goes to the next row, not back to the first", async () => {
    await open();
    within(screen.getByRole("list", { name: "Due now" }))
      .getByRole("button", { name: "Done" })
      .focus();
    await userEvent.keyboard("j");
    expect(screen.getByRole("listitem", { name: /^Sara Pinto/ })).toHaveFocus();
  });

  it("Important 4 (Review Focus 4): an open Snooze menu keeps its keys; E never finishes another row", async () => {
    await open();
    await userEvent.keyboard("jj"); // Omar Ali
    await userEvent.keyboard("s");
    expect(await screen.findByRole("menu")).toBeInTheDocument();
    await userEvent.keyboard("j");
    expect(screen.getByRole("menu")).toBeInTheDocument();
    expect(screen.getByRole("listitem", { name: /^Sara Pinto/ })).not.toHaveFocus();
    await userEvent.keyboard("e");
    expect(tasksClient.done).not.toHaveBeenCalled();
  });

  it("opened, it takes focus, so its keys work wherever focus was", async () => {
    render(
      <>
        <button type="button">Somewhere on the page</button>
        <NotificationCentre open onClose={vi.fn()} />
      </>,
    );
    await screen.findByRole("list", { name: "Overdue" });
    expect(screen.getByRole("dialog", { name: "Notifications" })).toHaveFocus();
    await userEvent.keyboard("f");
    expect(screen.getByRole("dialog", { name: "Notifications" })).toHaveAttribute("data-full");
  });

  it("Important 5: loading tells the bell how many are unread", async () => {
    await open();
    expect(sayUnread).toHaveBeenCalledWith(1);
  });
});

describe("the notification centre: 3C", () => {
  it("a system alert is an ask, and opens System health", async () => {
    vi.mocked(notificationsClient.list).mockResolvedValue(
      ok({
        items: [note(7, "system_alert", "Morning emails aren't going out.", { leadId: null })],
        unread: 1,
      }),
    );
    const onClose = await open();
    await userEvent.click(screen.getByRole("radio", { name: "Needs you" }));
    const item = screen.getByRole("listitem", { name: /Morning emails/ });
    await userEvent.click(within(item).getByRole("button", { name: "Open System health" }));
    expect(push).toHaveBeenCalledWith("/settings/health");
    expect(onClose).toHaveBeenCalled();
  });

  it("one that arrives while it's open is washed in the accent for a moment", async () => {
    await open();
    vi.mocked(notificationsClient.list).mockResolvedValue(
      ok({ items: [note(9, "lead_assigned", "Nadia Rahman was assigned to you"), ...updates], unread: 2 }),
    );
    await act(async () => live?.(note(9, "lead_assigned", "Nadia Rahman was assigned to you")));
    const row = await screen.findByRole("listitem", { name: /Nadia Rahman/ });
    expect(row).toHaveAttribute("data-arrived");
    expect(screen.getByRole("listitem", { name: /Karim Aziz/ })).not.toHaveAttribute("data-arrived");
  });
});
