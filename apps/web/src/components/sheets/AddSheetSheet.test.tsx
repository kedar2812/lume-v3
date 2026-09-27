import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { importsClient } from "@/lib/imports/client";
import type { DraftView } from "@/lib/imports/types";
import { sheetsClient } from "@/lib/sheets/client";
import { AddSheetSheet } from "./AddSheetSheet";

vi.mock("@/lib/sheets/client", () => ({ sheetsClient: { inspect: vi.fn(), draft: vi.fn(), save: vi.fn() } }));
vi.mock("@/lib/imports/client", () => ({ importsClient: { patch: vi.fn(), discard: vi.fn() } }));
// The 2A steps are tested on their own; here they only need to move the wizard along.
vi.mock("@/components/imports/ColumnsStep", () => ({
  ColumnsStep: ({ onContinue, notice }: { onContinue(): void; notice?: React.ReactNode }) => (
    <div>
      <h3>Columns</h3>
      {notice}
      <button onClick={onContinue}>Continue</button>
    </div>
  ),
}));
vi.mock("@/components/imports/RulesStep", () => ({
  RulesStep: ({ onContinue }: { onContinue(): void }) => <button onClick={onContinue}>Continue</button>,
}));
vi.mock("@/components/imports/PreviewStep", () => ({
  PreviewStep: ({ onContinue }: { onContinue?(): void }) => <button onClick={onContinue}>Continue</button>,
}));
const ok = <T,>(data: T) => ({ ok: true as const, status: 200, data });
const draft = {
  id: "d1",
  headers: ["Timestamp", "Name"],
  headerRow: 1,
  rowCount: 42,
  problems: [],
  mapping: { columns: [{ column: 1, to: "field", field: "name" }], createMissingTags: false },
} as unknown as DraftView;
const sheetDraft = {
  draft,
  sheet: {
    title: "Website enquiries",
    name: "Website enquiries",
    tabTitle: "Form responses",
    email: "lume@x.iam.gserviceaccount.com",
    moreRows: false,
    editing: null as string | null,
    pollSeconds: 120,
  },
};

beforeEach(() => vi.clearAllMocks());

describe("Add a sheet", () => {
  it("link → tab → the 2A steps → start from → saved", async () => {
    vi.mocked(sheetsClient.inspect).mockResolvedValue(
      ok({
        spreadsheetId: "abc",
        title: "Website enquiries",
        gid: 9,
        tabs: [
          { sheetId: 0, title: "Old" },
          { sheetId: 9, title: "Form responses" },
        ],
        email: "lume@x.iam.gserviceaccount.com",
      }),
    );
    vi.mocked(sheetsClient.draft).mockResolvedValue({ ...ok(sheetDraft), status: 201 });
    vi.mocked(sheetsClient.save).mockResolvedValue({ ...ok({ id: "s1" } as never), status: 201 });
    const onClose = vi.fn();
    render(<AddSheetSheet open onClose={onClose} />);
    const dialog = screen.getByRole("dialog", { name: "Add a sheet" });
    expect(dialog).toBeInTheDocument();
    await userEvent.type(
      screen.getByLabelText("Sheet link"),
      "https://docs.google.com/spreadsheets/d/abc/edit#gid=9",
    );
    await userEvent.click(screen.getByRole("button", { name: "Check" }));
    expect(await screen.findByLabelText("Tab")).toHaveValue("9"); // the tab the link pointed at
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(sheetsClient.draft).toHaveBeenCalledWith({
      link: "https://docs.google.com/spreadsheets/d/abc/edit#gid=9",
      sheetId: 9,
    });
    // No date column mapped: LUME says why it matters.
    expect(await screen.findByText(/can't tell a repeat enquiry/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Continue" })); // Columns
    await userEvent.click(screen.getByRole("button", { name: "Continue" })); // Rules
    await userEvent.click(screen.getByRole("button", { name: "Continue" })); // Preview
    expect(screen.getByLabelText("Name")).toHaveValue("Website enquiries");
    await userEvent.click(screen.getByRole("radio", { name: /Only rows added from now on/ }));
    await userEvent.selectOptions(screen.getByLabelText("Check for new rows"), "300");
    await userEvent.click(screen.getByRole("button", { name: "Connect sheet" }));
    expect(sheetsClient.save).toHaveBeenCalledWith({
      importId: "d1",
      name: "Website enquiries",
      pollSeconds: 300,
      startFrom: "new",
    });
    expect(onClose).toHaveBeenCalledWith("s1");
  });

  it("an unshared sheet says exactly what to do, with the email", async () => {
    vi.mocked(sheetsClient.inspect).mockResolvedValue({
      ok: false,
      status: 409,
      code: "SHEET_NO_ACCESS",
      message:
        "LUME can't open this sheet yet. Share it with lume@x.iam.gserviceaccount.com as a Viewer, then try again.",
    } as never);
    render(<AddSheetSheet open onClose={() => undefined} />);
    await userEvent.type(
      screen.getByLabelText("Sheet link"),
      "https://docs.google.com/spreadsheets/d/abc/edit",
    );
    await userEvent.click(screen.getByRole("button", { name: "Check" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Share it with lume@x.iam.gserviceaccount.com",
    );
  });

  it("editing a sheet starts at Columns, has no Start from choice, and saves", async () => {
    vi.mocked(sheetsClient.draft).mockResolvedValue({
      ...ok({ ...sheetDraft, sheet: { ...sheetDraft.sheet, editing: "s1" } }),
      status: 201,
    });
    vi.mocked(sheetsClient.save).mockResolvedValue(ok({ id: "s1" } as never));
    const onClose = vi.fn();
    render(<AddSheetSheet open sourceId="s1" onClose={onClose} />);
    expect(await screen.findByRole("heading", { name: "Columns" })).toBeInTheDocument();
    for (let i = 0; i < 3; i++) await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.queryByRole("radio")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(sheetsClient.save).toHaveBeenCalledWith(
      expect.objectContaining({ importId: "d1", startFrom: "all" }),
    );
    expect(onClose).toHaveBeenCalledWith("s1");
  });

  it("editing keeps the sheet's own check interval (finding 9)", async () => {
    vi.mocked(sheetsClient.draft).mockResolvedValue({
      ...ok({ ...sheetDraft, sheet: { ...sheetDraft.sheet, editing: "s1", pollSeconds: 3600 } }),
      status: 201,
    });
    vi.mocked(sheetsClient.save).mockResolvedValue(ok({ id: "s1" } as never));
    render(<AddSheetSheet open sourceId="s1" onClose={() => undefined} />);
    await screen.findByRole("heading", { name: "Columns" });
    for (let i = 0; i < 3; i++) await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByLabelText("Check for new rows")).toHaveValue("3600");
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(sheetsClient.save).toHaveBeenCalledWith(expect.objectContaining({ pollSeconds: 3600 }));
  });

  it("closing part-way throws the draft away (nothing half-made is kept)", async () => {
    vi.mocked(sheetsClient.draft).mockResolvedValue({
      ...ok({ ...sheetDraft, sheet: { ...sheetDraft.sheet, editing: "s1" } }),
      status: 201,
    });
    const onClose = vi.fn();
    render(<AddSheetSheet open sourceId="s1" onClose={onClose} />);
    await screen.findByRole("heading", { name: "Columns" });
    await userEvent.click(screen.getByRole("button", { name: "Close (Esc)" }));
    expect(importsClient.discard).toHaveBeenCalledWith("d1");
    expect(onClose).toHaveBeenCalledWith(undefined);
  });
  it("from a picked file, it lists that file's tabs — no link to paste", async () => {
    vi.mocked(sheetsClient.inspect).mockResolvedValue(
      ok({
        spreadsheetId: "f",
        title: "Picked leads",
        gid: null,
        tabs: [{ sheetId: 3, title: "Leads" }],
        email: "",
      }),
    );
    vi.mocked(sheetsClient.draft).mockResolvedValue({ ...ok(sheetDraft), status: 201 });
    render(
      <AddSheetSheet
        open
        connect={{ connectId: "c1", file: { id: "f", name: "Picked leads" } }}
        onClose={() => undefined}
      />,
    );
    expect(screen.queryByLabelText("Sheet link")).toBeNull();
    expect(await screen.findByLabelText("Tab")).toHaveValue("3");
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(sheetsClient.inspect).toHaveBeenCalledWith({ connectId: "c1" });
    expect(sheetsClient.draft).toHaveBeenCalledWith({ connectId: "c1", sheetId: 3 });
  });
});
