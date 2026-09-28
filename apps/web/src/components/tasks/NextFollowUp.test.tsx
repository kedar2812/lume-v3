import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { tasksClient } from "@/lib/tasks/client";
import type { TaskView } from "@/lib/tasks/types";
import { NextFollowUp } from "./NextFollowUp";

const play = vi.fn();
vi.mock("@/components/feedback/SoundProvider", () => ({ useSound: () => ({ play }) }));
vi.mock("@/lib/tasks/client", () => ({
  tasksClient: { forLead: vi.fn(), done: vi.fn(), snooze: vi.fn(), cancel: vi.fn() },
}));
const ok = <T,>(data: T) => ({ ok: true as const, status: 200, data });
const task = (over: Partial<TaskView> = {}): TaskView => ({
  id: "t1",
  leadId: "l1",
  leadName: "Aisha Khan",
  title: "Call back",
  note: null,
  dueAt: new Date(Date.now() + 26 * 3_600_000).toISOString(),
  status: "open",
  remindMinutes: [0],
  recurrence: null,
  assignee: { id: "u-me", name: "Maya Kapoor" },
  createdBy: null,
  doneAt: null,
  canEdit: true,
  ...over,
});

beforeEach(() => vi.clearAllMocks());

describe("Next follow-up", () => {
  it("shows the soonest open one in words, and nothing when there's none", async () => {
    vi.mocked(tasksClient.forLead).mockResolvedValue(
      ok({ items: [task(), task({ id: "t0", status: "done", title: "Old one" })] }),
    );
    const { unmount } = render(<NextFollowUp leadId="l1" tz="Asia/Dubai" meId="u-me" version={0} />);
    expect(await screen.findByText("Call back")).toBeInTheDocument();
    expect(screen.getByText(/^Tomorrow, \d\d:\d\d$|^\w{3}, \d\d:\d\d$/)).toBeInTheDocument();
    expect(screen.queryByText("Old one")).not.toBeInTheDocument();
    unmount();
    vi.mocked(tasksClient.forLead).mockResolvedValue(ok({ items: [] }));
    const { container } = render(<NextFollowUp leadId="l1" tz="Asia/Dubai" meId="u-me" version={0} />);
    await vi.waitFor(() => expect(tasksClient.forLead).toHaveBeenCalledTimes(2));
    expect(container).toBeEmptyDOMElement();
  });

  it("says who it's for when it isn't you", async () => {
    vi.mocked(tasksClient.forLead).mockResolvedValue(
      ok({ items: [task({ assignee: { id: "u-riya", name: "Riya Sharma" } })] }),
    );
    render(<NextFollowUp leadId="l1" tz="Asia/Dubai" meId="u-me" version={0} />);
    expect(await screen.findByText(/Riya Sharma/)).toBeInTheDocument();
  });

  it("the tick finishes it with the done sound; the day's last plays cleared", async () => {
    vi.mocked(tasksClient.forLead).mockResolvedValue(ok({ items: [task()] }));
    vi.mocked(tasksClient.done).mockResolvedValueOnce(
      ok({ task: task({ status: "done" }), next: null, clearedToday: false }),
    );
    render(<NextFollowUp leadId="l1" tz="Asia/Dubai" meId="u-me" version={0} />);
    await userEvent.click(await screen.findByRole("button", { name: "Mark “Call back” done" }));
    expect(tasksClient.done).toHaveBeenCalledWith("t1");
    expect(play).toHaveBeenCalledWith("done");
    vi.mocked(tasksClient.done).mockResolvedValueOnce(
      ok({ task: task({ status: "done" }), next: null, clearedToday: true }),
    );
    await userEvent.click(await screen.findByRole("button", { name: "Mark “Call back” done" }));
    expect(play).toHaveBeenLastCalledWith("cleared");
  });

  it("snooze from its menu", async () => {
    vi.mocked(tasksClient.forLead).mockResolvedValue(ok({ items: [task()] }));
    vi.mocked(tasksClient.snooze).mockResolvedValue(ok(task()));
    render(<NextFollowUp leadId="l1" tz="Asia/Dubai" meId="u-me" version={0} />);
    await userEvent.click(await screen.findByRole("button", { name: "More for “Call back”" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Tomorrow morning" }));
    expect(tasksClient.snooze).toHaveBeenCalledWith("t1", { preset: "tomorrow_morning" });
    expect(play).not.toHaveBeenCalled(); // snooze is silent (sound policy)
  });
});

describe("3A final review", () => {
  it("Minor 4: stepping to another lead never shows the previous lead's follow-up", async () => {
    let slow: (v: unknown) => void = () => undefined;
    vi.mocked(tasksClient.forLead)
      .mockReturnValueOnce(new Promise((r) => (slow = r)) as never)
      .mockResolvedValueOnce(ok({ items: [task({ id: "t2", leadId: "l2", title: "The second lead's" })] }));
    const { rerender } = render(<NextFollowUp leadId="l1" tz="Asia/Dubai" meId="u-me" version={0} />);
    rerender(<NextFollowUp leadId="l2" tz="Asia/Dubai" meId="u-me" version={0} />);
    expect(await screen.findByText("The second lead's")).toBeInTheDocument();
    slow(ok({ items: [task({ title: "The first lead's" })] })); // the first answer arrives late
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText("The first lead's")).not.toBeInTheDocument();
  });

  it("Minor 4: someone who can't change it sees it, without a tick that would only fail", async () => {
    vi.mocked(tasksClient.forLead).mockResolvedValue(ok({ items: [task({ canEdit: false })] }));
    render(<NextFollowUp leadId="l1" tz="Asia/Dubai" meId="u-me" version={0} />);
    expect(await screen.findByText("Call back")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /done$/ })).not.toBeInTheDocument();
  });
});
