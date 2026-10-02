import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { calendarClient } from "@/lib/calendar/client";
import { leadsClient } from "@/lib/leads/client";
import { pipelinesClient } from "@/lib/settings/pipelines";
import { tasksClient } from "@/lib/tasks/client";
import { LogOutcome } from "./LogOutcome";

vi.mock("@/lib/calendar/client", () => ({ calendarClient: { patchMeeting: vi.fn() } }));
vi.mock("@/lib/leads/client", () => ({ leadsClient: { get: vi.fn(), move: vi.fn() } }));
vi.mock("@/lib/settings/pipelines", () => ({ pipelinesClient: { list: vi.fn() } }));
vi.mock("@/lib/tasks/client", () => ({ tasksClient: { create: vi.fn(), presets: vi.fn() } }));
const ok = <T,>(data: T) => ({ ok: true as const, status: 200, data });

const TZ = "Asia/Dubai";
const MEETING = {
  id: "m1",
  title: "Pricing walkthrough",
  startsAt: "2026-10-01T07:30:00.000Z", // 11:30 am in Dubai
  endsAt: "2026-10-01T08:00:00.000Z",
  lead: { id: "l-karim", name: "Karim Aziz" },
};
const stage = (id: string, name: string, position: number, kind: "open" | "won" | "lost" = "open") => ({
  id,
  name,
  position,
  kind,
  color: "accent",
  requiredFieldIds: [],
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(leadsClient.get).mockResolvedValue(
    ok({
      lead: { id: "l-karim", version: 3, pipelineId: "p1", stageId: "s-booked", name: "Karim Aziz" },
    }) as never,
  );
  vi.mocked(pipelinesClient.list).mockResolvedValue(
    ok({
      pipelines: [
        {
          id: "p1",
          name: "Coaching sales",
          isDefault: true,
          bookingStageId: null,
          stages: [
            stage("s-new", "New", 0),
            stage("s-booked", "Call booked", 1),
            stage("s-done", "Call done", 2),
            stage("s-won", "Won", 3, "won"),
          ],
        },
      ],
    }) as never,
  );
  vi.mocked(tasksClient.presets).mockResolvedValue(
    ok({
      presets: [
        { id: "tomorrow_10", label: "Tomorrow at 10:00" },
        { id: "in_3d", label: "In 3 days" },
      ],
    }),
  );
  vi.mocked(calendarClient.patchMeeting).mockResolvedValue(ok({}) as never);
  vi.mocked(leadsClient.move).mockResolvedValue(ok({}) as never);
  vi.mocked(tasksClient.create).mockResolvedValue(ok({}) as never);
});

const open = (onDone = vi.fn()) => {
  render(<LogOutcome meeting={MEETING} tz={TZ} onClose={vi.fn()} onDone={onDone} />);
  return onDone;
};

describe("Log outcome", () => {
  it("asks how it went with the person, on the meeting's own time; Save waits for a choice", async () => {
    open();
    expect(await screen.findByRole("dialog", { name: "How did it go with Karim?" })).toBeInTheDocument();
    expect(screen.getByText(/Pricing walkthrough · .*11:30 am – 12 pm/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save outcome" })).toBeDisabled();
  });

  it("Held: records it with the note, moves the lead on to the next open stage, and sets the next step", async () => {
    const onDone = open();
    await userEvent.click(await screen.findByRole("radio", { name: /Held/ }));
    const move = await screen.findByRole("switch", { name: "Move Karim to Call done" });
    expect(move).toHaveAttribute("aria-checked", "true");
    await userEvent.type(screen.getByRole("textbox", { name: "Note" }), "Wants the annual plan");
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Next step" }), "In 3 days");
    await userEvent.click(screen.getByRole("button", { name: "Save outcome" }));
    expect(calendarClient.patchMeeting).toHaveBeenCalledWith("m1", {
      status: "completed",
      outcomeNote: "Wants the annual plan",
    });
    expect(leadsClient.move).toHaveBeenCalledWith("l-karim", "s-done");
    expect(tasksClient.create).toHaveBeenCalledWith("l-karim", {
      title: "Next step after Pricing walkthrough",
      due: { preset: "in_3d" },
    });
    expect(onDone).toHaveBeenCalled();
  });

  it("No-show: no move; a Rebook follow-up, on by default", async () => {
    open();
    await userEvent.click(await screen.findByRole("radio", { name: /No-show/ }));
    expect(screen.queryByRole("switch", { name: /^Move/ })).not.toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Set a Rebook follow-up" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await userEvent.click(screen.getByRole("button", { name: "Save outcome" }));
    expect(calendarClient.patchMeeting).toHaveBeenCalledWith("m1", { status: "no_show", outcomeNote: null });
    expect(leadsClient.move).not.toHaveBeenCalled();
    expect(tasksClient.create).toHaveBeenCalledWith("l-karim", {
      title: "Rebook Pricing walkthrough",
      due: { preset: "tomorrow_10" },
    });
  });

  it("a switch turned off does nothing; Rescheduled just records it", async () => {
    open();
    await userEvent.click(await screen.findByRole("radio", { name: /Held/ }));
    await userEvent.click(await screen.findByRole("switch", { name: "Move Karim to Call done" }));
    await userEvent.click(screen.getByRole("radio", { name: /Rescheduled/ }));
    await userEvent.click(screen.getByRole("button", { name: "Save outcome" }));
    expect(calendarClient.patchMeeting).toHaveBeenCalledWith("m1", {
      status: "rescheduled",
      outcomeNote: null,
    });
    expect(leadsClient.move).not.toHaveBeenCalled();
    expect(tasksClient.create).not.toHaveBeenCalled();
  });

  it("Review Focus 4: logged by someone else meanwhile, it says who, keeps the note, and changes nothing more", async () => {
    vi.mocked(calendarClient.patchMeeting).mockResolvedValue({
      ok: false,
      status: 409,
      code: "OUTCOME_RECORDED",
      message: "Ravi Menon already logged this meeting: Held.",
      details: { by: "Ravi Menon", status: "completed" },
    });
    const onDone = open();
    await userEvent.click(await screen.findByRole("radio", { name: /Held/ }));
    await userEvent.type(screen.getByRole("textbox", { name: "Note" }), "My notes from the call");
    await userEvent.click(screen.getByRole("button", { name: "Save outcome" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Ravi Menon already logged this meeting: Held.",
    );
    expect(screen.getByRole("textbox", { name: "Note" })).toHaveValue("My notes from the call");
    expect(leadsClient.move).not.toHaveBeenCalled();
    expect(tasksClient.create).not.toHaveBeenCalled();
    expect(onDone).not.toHaveBeenCalled();
  });

  it("a meeting not with a lead records the outcome only", async () => {
    render(<LogOutcome meeting={{ ...MEETING, lead: null }} tz={TZ} onClose={vi.fn()} onDone={vi.fn()} />);
    expect(await screen.findByRole("dialog", { name: "How did it go?" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("radio", { name: /Held/ }));
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
  });

  it("Review: a move the pipeline refuses keeps the dialog: the outcome is saved, and it says what didn't happen", async () => {
    vi.mocked(leadsClient.move).mockResolvedValue({
      ok: false,
      status: 422,
      code: "REQUIRED_FIELDS",
      message: "Call done needs Budget first.",
    } as never);
    const onDone = open();
    await userEvent.click(await screen.findByRole("radio", { name: /Held/ }));
    await screen.findByRole("switch", { name: "Move Karim to Call done" });
    await userEvent.click(screen.getByRole("button", { name: "Save outcome" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Outcome saved.");
    expect(alert).toHaveTextContent("Karim wasn't moved to Call done: Call done needs Budget first.");
    expect(onDone).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Save outcome" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open Karim" })).toHaveAttribute("href", "/leads?lead=l-karim");
    await userEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(onDone).toHaveBeenCalled();
    expect(calendarClient.patchMeeting).toHaveBeenCalledTimes(1);
  });

  it("Review: promises only what exists, and a date further off keeps its capitals", async () => {
    render(
      <LogOutcome
        meeting={{ ...MEETING, startsAt: "2026-09-14T07:30:00.000Z", endsAt: "2026-09-14T08:00:00.000Z" }}
        tz={TZ}
        onClose={vi.fn()}
        onDone={vi.fn()}
      />,
    );
    expect(await screen.findByText(/September 14, Monday, 11:30 am/)).toBeInTheDocument();
    expect(screen.queryByText(/analytics/i)).not.toBeInTheDocument();
    expect(screen.getByText("Pick one: LUME counts it in this week's numbers.")).toBeInTheDocument();
  });
});
