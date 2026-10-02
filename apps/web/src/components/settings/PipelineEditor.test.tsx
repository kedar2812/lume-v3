import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { testCatalog } from "@/lib/leads/test-catalog";
import type { Pipeline, Stage } from "@/lib/leads/types";
import { pipelinesClient } from "@/lib/settings/pipelines";
import { PipelineEditor } from "./PipelineEditor";

vi.mock("@/lib/settings/pipelines", () => ({
  pipelinesClient: {
    list: vi.fn(),
    addStage: vi.fn(),
    reorder: vi.fn(),
    patchStage: vi.fn(),
    archiveStage: vi.fn(),
  },
}));

vi.mock("@/lib/calendar/client", () => ({ calendarClient: { bookingStage: vi.fn() } }));
vi.mock("@/lib/templates/client", () => ({
  templatesClient: {
    list: vi.fn(async () => ({
      ok: true,
      status: 200,
      data: {
        templates: [
          {
            id: "0192f0a0-0000-7000-8000-0000000000a1",
            name: "See you soon",
            category: "reminder",
            body: "Hi {{lead.first_name}}, see you soon!",
            usable: true,
          },
        ],
      },
    })),
  },
}));

const ok = <T,>(data: T) => ({ ok: true as const, status: 200, data });
const catalog = testCatalog();
const stageOf = (id: string) => catalog.pipelines[0]!.stages.find((s) => s.id === id)!;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(pipelinesClient.patchStage).mockImplementation(async (id, patch) =>
    ok({ stage: { ...stageOf(id), ...patch } as Stage }),
  );
  vi.mocked(pipelinesClient.reorder).mockImplementation(async (id, ids) =>
    ok({
      pipeline: {
        ...catalog.pipelines[0]!,
        stages: ids.map((sid, position) => ({ ...(stageOf(sid) ?? added), position })),
      } as Pipeline,
    }),
  );
  vi.mocked(pipelinesClient.archiveStage).mockResolvedValue(ok(null));
  vi.mocked(pipelinesClient.list).mockResolvedValue(ok({ pipelines: catalog.pipelines }));
});

const added: Stage = {
  id: "s-prop",
  name: "Proposal sent",
  color: "neutral",
  kind: "open",
  position: 5,
  requiredFieldIds: [],
};
const renderEditor = () => render(<PipelineEditor pipelines={catalog.pipelines} fields={catalog.fields} />);

describe("PipelineEditor", () => {
  it("renames, recolours and reorders stages, and saves each change as it's made", async () => {
    renderEditor();
    await userEvent.click(screen.getByRole("button", { name: "Rename Message sent" }));
    await userEvent.clear(screen.getByRole("textbox", { name: "Stage name" }));
    await userEvent.type(screen.getByRole("textbox", { name: "Stage name" }), "Messaged{Enter}");
    expect(pipelinesClient.patchStage).toHaveBeenCalledWith("s-sent", { name: "Messaged" });
    expect(await screen.findByText("Messaged")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Open New" })); // its settings sit beside the list
    await userEvent.click(screen.getByRole("button", { name: "Colour for New" }));
    await userEvent.click(screen.getByRole("radio", { name: "Cyan" }));
    expect(pipelinesClient.patchStage).toHaveBeenCalledWith("s-new", { color: "cyan" });

    fireEvent.keyDown(screen.getByRole("button", { name: "Move New" }), { key: "ArrowDown", altKey: true });
    expect(pipelinesClient.reorder).toHaveBeenCalledWith("p1", [
      "s-sent",
      "s-new",
      "s-booked",
      "s-won",
      "s-lost",
    ]);
  });

  it("undoes a rename from the quiet note that confirms it", async () => {
    renderEditor();
    await userEvent.click(screen.getByRole("button", { name: "Rename Message sent" }));
    await userEvent.clear(screen.getByRole("textbox", { name: "Stage name" }));
    await userEvent.type(screen.getByRole("textbox", { name: "Stage name" }), "Messaged{Enter}");
    const note = await screen.findByRole("status");
    expect(note).toHaveTextContent("Renamed to Messaged");
    await userEvent.click(within(note).getByRole("button", { name: "Undo" }));
    expect(pipelinesClient.patchStage).toHaveBeenLastCalledWith("s-sent", { name: "Message sent" });
  });

  it("asks where a stage's leads go before archiving it, offering only this pipeline's other open stages", async () => {
    renderEditor();
    await userEvent.click(screen.getByRole("button", { name: "Archive Call booked" }));
    const ask = screen.getByRole("dialog", { name: "Archive Call booked?" });
    const choices = within(ask)
      .getAllByRole("radio")
      .map((r) => r.getAttribute("aria-label"));
    expect(choices).toEqual(["New", "Message sent"]);
    await userEvent.click(within(ask).getByRole("radio", { name: "Message sent" }));
    await userEvent.click(within(ask).getByRole("button", { name: "Archive and move its leads" }));
    expect(pipelinesClient.archiveStage).toHaveBeenCalledWith("s-booked", "s-sent");
    expect(pipelinesClient.list).toHaveBeenCalled(); // the list reloads, so what's shown is what's saved
  });

  it("can't archive until a place for the leads is chosen", async () => {
    renderEditor();
    await userEvent.click(screen.getByRole("button", { name: "Archive New" }));
    const ask = screen.getByRole("dialog", { name: "Archive New?" });
    expect(within(ask).getByRole("button", { name: "Archive and move its leads" })).toBeDisabled();
  });

  it("sets the fields a stage needs, from the lead's fields", async () => {
    renderEditor();
    await userEvent.click(screen.getByRole("button", { name: "Open Call booked" }));
    await userEvent.click(screen.getByRole("button", { name: "Needs for Call booked" }));
    await userEvent.click(screen.getByRole("checkbox", { name: "Struggles" }));
    expect(pipelinesClient.patchStage).toHaveBeenCalledWith("s-booked", { requiredFieldIds: ["f-str"] });
  });

  it("shows the API's reason when a change would leave no Won or Lost stage", async () => {
    vi.mocked(pipelinesClient.patchStage).mockResolvedValueOnce({
      ok: false,
      status: 400,
      code: "STAGE_KINDS_REQUIRED",
      message: "A pipeline needs at least one Won and one Lost stage",
    });
    renderEditor();
    await userEvent.click(screen.getByRole("button", { name: "Open Won" }));
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Kind of Won" }), "open");
    expect(pipelinesClient.patchStage).toHaveBeenCalledWith("s-won", { kind: "open" });
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "A pipeline needs at least one Won and one Lost stage",
    );
    expect(screen.getByRole("combobox", { name: "Kind of Won" })).toHaveValue("won"); // put back
  });

  it("adds a new stage just before Won and Lost", async () => {
    vi.mocked(pipelinesClient.addStage).mockResolvedValue(ok({ stage: added }));
    renderEditor();
    await userEvent.type(screen.getByRole("textbox", { name: "New stage" }), "Proposal sent{Enter}");
    expect(pipelinesClient.addStage).toHaveBeenCalledWith("p1", { name: "Proposal sent", kind: "open" });
    expect(pipelinesClient.reorder).toHaveBeenCalledWith("p1", [
      "s-new",
      "s-sent",
      "s-booked",
      "s-prop",
      "s-won",
      "s-lost",
    ]);
  });

  it("sets how long a lead may sit in a stage, or clears it", async () => {
    renderEditor();
    await userEvent.click(screen.getByRole("button", { name: "Open New" }));
    const sla = screen.getByRole("spinbutton", { name: "Hours allowed in New" });
    await userEvent.type(sla, "24");
    fireEvent.blur(sla);
    expect(pipelinesClient.patchStage).toHaveBeenCalledWith("s-new", { slaHours: 24 });
  });
});

describe("PipelineEditor: automations (3C Task 6)", () => {
  it("each stage says what it does when a lead enters; the sheet saves its automations with the stage", async () => {
    const withRule: Pipeline[] = catalog.pipelines.map((p) => ({
      ...p,
      stages: p.stages.map((st) =>
        st.id === "s-sent"
          ? {
              ...st,
              onEnter: {
                rules: [
                  {
                    id: "0192f0a0-0000-7000-8000-000000000001",
                    type: "create_task" as const,
                    title: "Send the plan",
                    dueIn: { n: 2, unit: "day" as const },
                    assignee: "lead_owner" as const,
                  },
                ],
              },
            }
          : st,
      ),
    }));
    render(<PipelineEditor pipelines={withRule} fields={catalog.fields} people={catalog.people} />);
    // The list says how many each stage has; the chosen stage lists them, one line each.
    expect(screen.getByRole("button", { name: "Open Message sent" })).toHaveTextContent("1 automation");
    await userEvent.click(screen.getByRole("button", { name: "Open Message sent" }));
    const sent = screen.getByRole("list", { name: "What Message sent does" });
    expect(
      within(sent).getByText("Sets a follow-up for the lead's owner in 2 days: Send the plan"),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Open New" }));
    await userEvent.click(screen.getByRole("button", { name: "Change what New does" }));
    const sheet = screen.getByRole("dialog", { name: "What New does" });
    await userEvent.click(within(sheet).getByRole("button", { name: "Clear open follow-ups" }));
    await userEvent.click(within(sheet).getByRole("button", { name: "Save" }));
    expect(pipelinesClient.patchStage).toHaveBeenCalledWith("s-new", {
      onEnter: { rules: [{ id: expect.any(String), type: "cancel_open_tasks" }] },
    });
    const summary = await screen.findByRole("list", { name: "What New does" });
    expect(within(summary).getByText("Clears the lead's open follow-ups")).toBeInTheDocument();
  });

  it("Moves (4A): where a lead goes after a message or a reply, chosen in Does and saved with the stage", async () => {
    render(<PipelineEditor pipelines={catalog.pipelines} fields={catalog.fields} people={catalog.people} />);
    await userEvent.click(screen.getByRole("button", { name: "Open New" }));
    await userEvent.click(screen.getByRole("button", { name: "Change what New does" }));
    const sheet = screen.getByRole("dialog", { name: "What New does" });
    const moves = within(sheet).getByRole("group", { name: "Moves" });
    const sent = within(moves).getByRole("combobox", { name: "After a message is sent, move to" });
    // This pipeline's other stages; never Lost, which always needs a reason a send can't give.
    expect(
      within(sent)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["Stay here", "Message sent", "Call booked", "Won"]);
    await userEvent.selectOptions(sent, "Message sent");
    await userEvent.selectOptions(
      within(moves).getByRole("combobox", { name: "After a reply, move to" }),
      "Call booked",
    );
    await userEvent.click(within(sheet).getByRole("button", { name: "Save" }));
    expect(pipelinesClient.patchStage).toHaveBeenCalledWith("s-new", {
      onEnter: { rules: [] },
      afterSentStageId: "s-sent",
      afterReplyStageId: "s-booked",
    });
    const summary = await screen.findByRole("list", { name: "What New does" });
    expect(within(summary).getByText("After a message is sent: moves to Message sent")).toBeInTheDocument();
    expect(within(summary).getByText("After a reply: moves to Call booked")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open New" })).toHaveTextContent("2 automations");
  });

  it("Moves: a refusal keeps the sheet open with LUME's words, and nothing changes", async () => {
    vi.mocked(pipelinesClient.patchStage).mockResolvedValueOnce({
      ok: false,
      status: 422,
      code: "VALIDATION",
      message: "Pick a stage in this pipeline",
    } as never);
    render(<PipelineEditor pipelines={catalog.pipelines} fields={catalog.fields} people={catalog.people} />);
    await userEvent.click(screen.getByRole("button", { name: "Open New" }));
    await userEvent.click(screen.getByRole("button", { name: "Change what New does" }));
    const sheet = screen.getByRole("dialog", { name: "What New does" });
    await userEvent.selectOptions(
      within(sheet).getByRole("combobox", { name: "After a reply, move to" }),
      "Call booked",
    );
    await userEvent.click(within(sheet).getByRole("button", { name: "Save" }));
    expect(await within(sheet).findByText("Pick a stage in this pipeline")).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "What New does" })).not.toBeInTheDocument();
  });

  it("a stage that already moves leads shows it, and Stay here takes it off", async () => {
    const moving = catalog.pipelines.map((p) => ({
      ...p,
      stages: p.stages.map((st) => (st.id === "s-new" ? { ...st, afterSentStageId: "s-sent" } : st)),
    }));
    render(<PipelineEditor pipelines={moving} fields={catalog.fields} people={catalog.people} />);
    await userEvent.click(screen.getByRole("button", { name: "Open New" }));
    expect(screen.getByText("After a message is sent: moves to Message sent")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Change what New does" }));
    const sheet = screen.getByRole("dialog", { name: "What New does" });
    const sent = within(sheet).getByRole("combobox", { name: "After a message is sent, move to" });
    expect(sent).toHaveValue("s-sent");
    await userEvent.selectOptions(sent, "Stay here");
    await userEvent.click(within(sheet).getByRole("button", { name: "Save" }));
    expect(pipelinesClient.patchStage).toHaveBeenCalledWith("s-new", {
      onEnter: { rules: [] },
      afterSentStageId: null,
    });
  });
});

describe("PipelineEditor: simplified (5D Task 9)", () => {
  it("Won and Lost sit in their own Outcomes group", () => {
    renderEditor();
    const outcomes = screen.getByRole("list", { name: "Outcomes" });
    expect(within(outcomes).getByText("Won")).toBeInTheDocument();
    expect(within(outcomes).getByText("Lost")).toBeInTheDocument();
    expect(within(screen.getByRole("list", { name: "Stages" })).queryByText("Won")).not.toBeInTheDocument();
  });

  it("with Calendly connected, the booking sentence sets the booking stage, from open stages only", async () => {
    const { calendarClient } = await import("@/lib/calendar/client");
    vi.mocked(calendarClient.bookingStage).mockResolvedValue(
      ok({ pipeline: { ...catalog.pipelines[0]!, bookingStageId: "s-booked" } }),
    );
    render(<PipelineEditor pipelines={catalog.pipelines} fields={catalog.fields} calendly />);
    const sentence = screen.getByRole("group", { name: "Calendly bookings" });
    expect(sentence).toHaveTextContent(
      "When someone books a call through Calendly, LUME moves their lead to",
    );
    const pick = within(sentence).getByRole("combobox", { name: "Booking stage" });
    expect(
      within(pick)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["Leave it where it is", "New", "Message sent", "Call booked"]);
    await userEvent.selectOptions(pick, "Call booked");
    expect(calendarClient.bookingStage).toHaveBeenCalledWith("p1", "s-booked");
    expect(await screen.findByRole("img", { name: "Calendly's booking stage" })).toBeInTheDocument();
    expect(within(sentence).getByRole("link", { name: "Calendly settings" })).toHaveAttribute(
      "href",
      "/settings/integrations/calendly",
    );
  });

  it("without Calendly, there is no booking sentence", () => {
    renderEditor();
    expect(screen.queryByRole("group", { name: "Calendly bookings" })).not.toBeInTheDocument();
  });

  it("Add an automation offers the meeting reminder once; it opens the editor with it added", async () => {
    render(<PipelineEditor pipelines={catalog.pipelines} fields={catalog.fields} people={catalog.people} />);
    await userEvent.click(screen.getByRole("button", { name: "Open Call booked" }));
    await userEvent.click(screen.getByRole("button", { name: "Add an automation" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Remind the lead before their call" }));
    const sheet = await screen.findByRole("dialog", { name: "What Call booked does" });
    expect(within(sheet).getByRole("spinbutton", { name: "Hours before the meeting" })).toHaveValue(2);
  });
});
