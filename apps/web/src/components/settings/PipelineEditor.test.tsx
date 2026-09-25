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
    const sla = screen.getByRole("spinbutton", { name: "Hours allowed in New" });
    await userEvent.type(sla, "24");
    fireEvent.blur(sla);
    expect(pipelinesClient.patchStage).toHaveBeenCalledWith("s-new", { slaHours: 24 });
  });
});
