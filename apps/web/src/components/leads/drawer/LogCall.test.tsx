import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { leadsClient } from "@/lib/leads/client";
import { tasksClient } from "@/lib/tasks/client";
import { LogCall } from "./LogCall";

const toast = vi.fn();
vi.mock("@/components/feedback/ToastProvider", () => ({ useToast: () => ({ toast, dismiss: vi.fn() }) }));
vi.mock("@/lib/leads/client", () => ({ leadsClient: { logCall: vi.fn() } }));
vi.mock("@/lib/tasks/client", () => ({ tasksClient: { presets: vi.fn(), create: vi.fn() } }));
const ok = <T,>(data: T) => ({ ok: true as const, status: 200, data });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(tasksClient.presets).mockResolvedValue(
    ok({
      presets: [
        { id: "tomorrow_10", label: "Tomorrow 10:00" },
        { id: "in_2d", label: "In 2 days" },
      ],
    }),
  );
  vi.mocked(tasksClient.create).mockResolvedValue(ok({}) as never);
  vi.mocked(leadsClient.logCall).mockResolvedValue(
    ok({ activity: {} as never, firstContact: { minutes: 44 } }),
  );
});
const open = async () => {
  const onLogged = vi.fn();
  render(<LogCall lead={{ id: "l1", name: "Ananya Rao" }} tz="Asia/Kolkata" onLogged={onLogged} />);
  await userEvent.click(screen.getByRole("button", { name: "Log a call (C)" }));
  await screen.findByRole("radio", { name: /Tomorrow 10:00/ });
  return onLogged;
};

describe("Log a call (the approved LogCall board)", () => {
  it("talked, what they said, no follow-up: logged, and LUME says it was the first contact and how soon", async () => {
    const onLogged = await open();
    expect(screen.getByRole("radio", { name: /Talked/ })).toHaveAttribute("aria-checked", "true");
    await userEvent.type(screen.getByRole("textbox"), "Wants the café package");
    await userEvent.click(screen.getByRole("button", { name: "Log call" }));
    expect(leadsClient.logCall).toHaveBeenCalledWith("l1", "talked", "Wants the café package");
    expect(tasksClient.create).not.toHaveBeenCalled();
    await waitFor(() => expect(onLogged).toHaveBeenCalled());
    expect(toast).toHaveBeenCalledWith({
      tone: "ok",
      title: "Call logged",
      detail: "First contact with Ananya: 44 min after the enquiry.",
    });
  });

  it("2 picks no answer, which suggests trying again tomorrow, and sets that follow-up", async () => {
    await open();
    await userEvent.keyboard("2");
    expect(screen.getByRole("radio", { name: /No answer/ })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("radio", { name: "Tomorrow 10:00" })).toHaveAttribute("aria-checked", "true");
    await userEvent.click(screen.getByRole("button", { name: "Log call" }));
    expect(leadsClient.logCall).toHaveBeenCalledWith("l1", "no_answer", undefined);
    await waitFor(() =>
      expect(tasksClient.create).toHaveBeenCalledWith("l1", {
        title: "Try calling again",
        due: { preset: "tomorrow_10" },
        remindMinutes: [0],
        recurrence: null,
      }),
    );
  });

  it("Pick a time needs a time; a failed call isn't closed or lost", async () => {
    await open();
    await userEvent.click(screen.getByRole("radio", { name: "Pick a time…" }));
    await userEvent.click(screen.getByRole("button", { name: "Log call" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Pick a date and time.");
    expect(leadsClient.logCall).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("radio", { name: "No follow-up" }));
    vi.mocked(leadsClient.logCall).mockResolvedValueOnce({
      ok: false,
      status: 500,
      message: "Offline",
    } as never);
    await userEvent.click(screen.getByRole("button", { name: "Log call" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Offline");
    expect(screen.getByRole("dialog", { name: "Log a call" })).toBeInTheDocument();
  });
});
