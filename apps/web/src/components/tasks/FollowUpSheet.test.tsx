import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { tasksClient } from "@/lib/tasks/client";
import { FollowUpSheet } from "./FollowUpSheet";

vi.mock("@/lib/tasks/client", () => ({ tasksClient: { create: vi.fn(), presets: vi.fn() } }));
const ok = <T,>(data: T) => ({ ok: true as const, status: 201, data });
const people = [
  { id: "u-me", name: "Maya Kapoor", active: true },
  { id: "u-riya", name: "Riya Sharma", active: true },
  { id: "u-gone", name: "Omar Gone", active: false },
];
const open = async (o: { canAssign?: boolean } = {}) => {
  const onSaved = vi.fn();
  render(
    <FollowUpSheet
      lead={{ id: "l1", name: "Aisha Khan" }}
      tz="Asia/Dubai"
      meId="u-me"
      canAssign={o.canAssign ?? false}
      people={people}
      onSaved={onSaved}
    />,
  );
  await userEvent.click(screen.getByRole("button", { name: "Follow-up" }));
  return onSaved;
};

const DEFAULTS = [
  { id: "in_1h", label: "In 1 hour" },
  { id: "in_3h", label: "In 3 hours" },
  { id: "tomorrow_10", label: "Tomorrow 10:00" },
  { id: "in_2d", label: "In 2 days" },
  { id: "next_monday", label: "Next Monday" },
];
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(tasksClient.create).mockResolvedValue(ok({ id: "t1" } as never));
  vi.mocked(tasksClient.presets).mockResolvedValue(ok({ presets: DEFAULTS }));
});

describe("Follow-up", () => {
  it("two taps: tomorrow at 10, with a reminder an hour before as well as at the time", async () => {
    const onSaved = await open();
    expect(screen.getByRole("dialog", { name: "Follow up with Aisha" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("radio", { name: "Tomorrow 10:00" }));
    await userEvent.click(screen.getByRole("checkbox", { name: "1 hour before" }));
    await userEvent.click(screen.getByRole("button", { name: "Set follow-up" }));
    expect(tasksClient.create).toHaveBeenCalledWith("l1", {
      title: "Follow up",
      due: { preset: "tomorrow_10" },
      remindMinutes: [0, 60],
      recurrence: null,
    });
    expect(onSaved).toHaveBeenCalled();
  });

  it("a picked time is the person's own wall clock", async () => {
    await open();
    await userEvent.click(screen.getByRole("radio", { name: "Pick a time" }));
    await userEvent.type(screen.getByLabelText("Date and time"), "2026-09-29T10:00");
    await userEvent.click(screen.getByRole("button", { name: "Set follow-up" }));
    expect(tasksClient.create).toHaveBeenCalledWith(
      "l1",
      expect.objectContaining({ due: { at: "2026-09-29T06:00:00.000Z" } }),
    );
  });

  it("repeats until they reply, win or are lost", async () => {
    await open();
    await userEvent.selectOptions(screen.getByLabelText("Repeat"), "Every 3 days");
    await userEvent.click(screen.getByRole("button", { name: "Set follow-up" }));
    expect(tasksClient.create).toHaveBeenCalledWith(
      "l1",
      expect.objectContaining({
        recurrence: { every: 3, unit: "day", until: null, stopOn: ["won", "lost", "reply_logged"] },
      }),
    );
  });

  it("'For' only when the person may give follow-ups to others; only active people", async () => {
    await open();
    expect(screen.queryByLabelText("For")).not.toBeInTheDocument();
  });

  it("with it, a follow-up can be someone else's", async () => {
    await open({ canAssign: true });
    const who = screen.getByLabelText("For");
    expect(screen.queryByRole("option", { name: "Omar Gone" })).not.toBeInTheDocument();
    await userEvent.selectOptions(who, "Riya Sharma");
    await userEvent.click(screen.getByRole("button", { name: "Set follow-up" }));
    expect(tasksClient.create).toHaveBeenCalledWith("l1", expect.objectContaining({ assigneeId: "u-riya" }));
  });
});

describe("Follow-up: the time choices an admin set (3C Task 6)", () => {
  it("shows them, in their order, and sends the one picked", async () => {
    vi.mocked(tasksClient.presets).mockResolvedValue(
      ok({ presets: [{ id: "in_30_minutes", label: "In 30 minutes" }, ...DEFAULTS.slice(2)] }),
    );
    await open();
    await userEvent.click(await screen.findByRole("radio", { name: "In 30 minutes" }));
    expect(screen.queryByRole("radio", { name: "In 1 hour" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Set follow-up" }));
    expect(tasksClient.create).toHaveBeenCalledWith(
      "l1",
      expect.objectContaining({ due: { preset: "in_30_minutes" } }),
    );
  });

  it("a choice removed while the sheet was open: LUME says so, and shows the new ones", async () => {
    vi.mocked(tasksClient.create).mockResolvedValueOnce({
      ok: false,
      status: 400,
      code: "UNKNOWN_PRESET",
      message: "That time choice was just changed. Pick another.",
    });
    await open();
    await userEvent.click(await screen.findByRole("radio", { name: "Next Monday" }));
    vi.mocked(tasksClient.presets).mockResolvedValue(ok({ presets: DEFAULTS.slice(0, 4) }));
    await userEvent.click(screen.getByRole("button", { name: "Set follow-up" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("That time choice was just changed");
    await vi.waitFor(() =>
      expect(screen.queryByRole("radio", { name: "Next Monday" })).not.toBeInTheDocument(),
    );
  });
});
