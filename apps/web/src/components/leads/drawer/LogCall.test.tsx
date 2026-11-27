import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { leadsClient } from "@/lib/leads/client";
import { listsClient } from "@/lib/settings/lists";
import { tasksClient } from "@/lib/tasks/client";
import type { Stage } from "@/lib/leads/types";
import { LogCall } from "./LogCall";

const toast = vi.fn();
vi.mock("@/components/feedback/ToastProvider", () => ({ useToast: () => ({ toast, dismiss: vi.fn() }) }));
vi.mock("@/lib/leads/client", () => ({ leadsClient: { logCall: vi.fn() } }));
vi.mock("@/lib/tasks/client", () => ({ tasksClient: { presets: vi.fn(), create: vi.fn() } }));
vi.mock("@/lib/settings/lists", () => ({ listsClient: { reasons: vi.fn() } }));
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
  vi.mocked(listsClient.reasons).mockResolvedValue(
    ok({ lostReasons: [{ id: "r-price", label: "Too expensive", position: 0 }] }) as never,
  );
  vi.mocked(leadsClient.logCall).mockResolvedValue(
    ok({ activity: { id: "a1" } as never, firstContact: { minutes: 44 } }),
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
    // The call it saved, and that it has words in it: LUME AI can read it into a next step.
    await waitFor(() => expect(onLogged).toHaveBeenCalledWith("a1", true));
    expect(toast).toHaveBeenCalledWith({
      tone: "ok",
      title: "Call logged",
      detail: "First contact with Ananya: 44 min after the enquiry.",
    });
  });

  it("2 picks no answer, which suggests trying again tomorrow, and sets that follow-up", async () => {
    const onLogged = await open();
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
    // No words, nothing for LUME AI to read.
    await waitFor(() => expect(onLogged).toHaveBeenCalledWith("a1", false));
  });

  it("a follow-up that couldn't be set is said, even on a first contact; an enquiry date reads in days", async () => {
    vi.mocked(tasksClient.create).mockResolvedValueOnce({ ok: false, status: 500, message: "x" } as never);
    vi.mocked(leadsClient.logCall).mockResolvedValueOnce(
      ok({ activity: {} as never, firstContact: { days: 3 } }),
    );
    await open();
    await userEvent.click(screen.getByRole("radio", { name: "Tomorrow 10:00" }));
    await userEvent.click(screen.getByRole("button", { name: "Log call" }));
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith({
        tone: "warn",
        title: "Call logged",
        detail:
          "The follow-up wasn’t set. Add it with Follow-up. First contact with Ananya: 3 days after the enquiry date.",
      }),
    );
  });

  it("1, 2 and 3 pick how it went, but not with Ctrl or ⌘ held, and not by holding a key down", async () => {
    await open();
    await userEvent.keyboard("{Control>}2{/Control}");
    expect(screen.getByRole("radio", { name: /Talked/ })).toHaveAttribute("aria-checked", "true");
    await userEvent.keyboard("3");
    expect(screen.getByRole("radio", { name: /Left a message/ })).toHaveAttribute("aria-checked", "true");
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

const st = (id: string, name: string, position: number, kind: Stage["kind"] = "open"): Stage => ({
  id,
  name,
  position,
  kind,
  color: "accent",
  requiredFieldIds: [],
});
const STAGES = [
  st("s-new", "New", 0),
  st("s-talk", "Talking", 1),
  st("s-won", "Won", 2, "won"),
  st("s-lost", "Lost", 3, "lost"),
];
const openWithStage = async () => {
  const onMove = vi.fn().mockResolvedValue(undefined);
  render(
    <LogCall
      lead={{ id: "l1", name: "Ananya Rao" }}
      tz="Asia/Kolkata"
      onLogged={vi.fn()}
      stage={{ stages: STAGES, currentId: "s-new" }}
      onMove={onMove}
    />,
  );
  await userEvent.click(screen.getByRole("button", { name: "Log a call (C)" }));
  await screen.findByRole("radio", { name: /Tomorrow 10:00/ });
  return onMove;
};

describe("Log a call: the stage (owner 2026-11-27, any stage from the log cards)", () => {
  it("starts on Stays: logging moves nothing", async () => {
    const onMove = await openWithStage();
    expect(screen.getByRole("combobox", { name: "Stage" })).toHaveValue("");
    await userEvent.click(screen.getByRole("button", { name: "Log call" }));
    await waitFor(() => expect(toast).toHaveBeenCalled());
    expect(onMove).not.toHaveBeenCalled();
  });

  it("a stage picked: the call is logged first, then the lead moves there", async () => {
    const onMove = await openWithStage();
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Stage" }), "Talking");
    await userEvent.click(screen.getByRole("button", { name: "Log call" }));
    await waitFor(() => expect(onMove).toHaveBeenCalledWith(STAGES[1], {}));
    expect(vi.mocked(leadsClient.logCall).mock.invocationCallOrder[0]!).toBeLessThan(
      onMove.mock.invocationCallOrder[0]!,
    );
  });

  it("Lost asks why in the card, and the move carries the reason", async () => {
    const onMove = await openWithStage();
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Stage" }), "Lost");
    const why = await screen.findByRole("combobox", { name: "Why was Ananya lost?" });
    expect(screen.getByRole("button", { name: "Log call" })).toBeDisabled();
    await userEvent.selectOptions(why, "Too expensive");
    await userEvent.click(screen.getByRole("button", { name: "Log call" }));
    await waitFor(() => expect(onMove).toHaveBeenCalledWith(STAGES[3], { lostReasonId: "r-price" }));
  });

  it("a call that wasn't logged moves nothing", async () => {
    vi.mocked(leadsClient.logCall).mockResolvedValueOnce({
      ok: false,
      status: 500,
      message: "Offline",
    } as never);
    const onMove = await openWithStage();
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Stage" }), "Won");
    await userEvent.click(screen.getByRole("button", { name: "Log call" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Offline");
    expect(onMove).not.toHaveBeenCalled();
  });

  it("opened again after a log: back on Stays", async () => {
    await openWithStage();
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Stage" }), "Talking");
    await userEvent.click(screen.getByRole("button", { name: "Log call" }));
    await waitFor(() => expect(toast).toHaveBeenCalled());
    await userEvent.click(screen.getByRole("button", { name: "Log a call (C)" }));
    expect(await screen.findByRole("combobox", { name: "Stage" })).toHaveValue("");
  });

  it("no pipeline given: no stage row", async () => {
    await open();
    expect(screen.queryByRole("combobox", { name: "Stage" })).not.toBeInTheDocument();
  });
});
