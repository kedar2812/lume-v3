import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { testCatalog } from "@/lib/leads/test-catalog";
import type { FieldDefView } from "@/lib/leads/types";
import { fieldsClient } from "@/lib/settings/fields";
import { FieldsEditor } from "./FieldsEditor";

vi.mock("@/lib/settings/fields", () => ({
  fieldsClient: { list: vi.fn(), create: vi.fn(), patch: vi.fn(), archive: vi.fn() },
}));

const catalog = testCatalog();
const ok = <T,>(data: T) => ({ ok: true as const, status: 200, data });
const made: FieldDefView = {
  id: "f-budget",
  key: "budget_band",
  label: "Budget band",
  type: "select",
  options: [{ id: "o9", label: "Under 5k" }],
  isCore: false,
  isRequired: false,
  archived: false,
  access: "edit",
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(fieldsClient.create).mockResolvedValue(ok({ field: made }));
  vi.mocked(fieldsClient.patch).mockImplementation(async (id, patch) =>
    ok({ field: { ...catalog.fields.find((f) => f.id === id)!, ...patch } as FieldDefView }),
  );
  vi.mocked(fieldsClient.archive).mockResolvedValue(ok(null));
});

describe("FieldsEditor", () => {
  it("adds a select field and shows it in the lead form preview as it's being made", async () => {
    render(<FieldsEditor catalog={catalog} />);
    await userEvent.click(screen.getByRole("button", { name: "Add a field" }));
    await userEvent.type(screen.getByLabelText("Field name"), "Budget band");
    await userEvent.selectOptions(screen.getByLabelText("Type"), "select");
    await userEvent.type(screen.getByRole("textbox", { name: "New option" }), "Under 5k{Enter}");
    const preview = screen.getByRole("region", { name: "Lead form preview" });
    const combo = within(preview).getByRole("combobox", { name: "Budget band" });
    expect(within(combo).getByRole("option", { name: "Under 5k" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Create field" }));
    expect(fieldsClient.create).toHaveBeenCalledWith({
      key: "budget_band",
      label: "Budget band",
      type: "select",
      options: [{ label: "Under 5k" }],
      isRequired: false,
    });
    expect(await screen.findByRole("button", { name: "Edit Budget band" })).toBeInTheDocument();
  });

  it("makes a key that doesn't clash with one already used", async () => {
    render(<FieldsEditor catalog={catalog} />);
    await userEvent.click(screen.getByRole("button", { name: "Add a field" }));
    await userEvent.type(screen.getByLabelText("Field name"), "Struggles!");
    await userEvent.click(screen.getByRole("button", { name: "Create field" }));
    expect(fieldsClient.create).toHaveBeenCalledWith(
      expect.objectContaining({ key: "struggles_2", type: "text" }),
    );
  });

  it("needs a name, and at least one option for a select field", async () => {
    render(<FieldsEditor catalog={catalog} />);
    await userEvent.click(screen.getByRole("button", { name: "Add a field" }));
    await userEvent.selectOptions(screen.getByLabelText("Type"), "multi_select");
    await userEvent.click(screen.getByRole("button", { name: "Create field" }));
    expect(screen.getByText("Give the field a name")).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("Field name"), "Goals");
    await userEvent.click(screen.getByRole("button", { name: "Create field" }));
    expect(screen.getByText("Add at least one option")).toBeInTheDocument();
    expect(fieldsClient.create).not.toHaveBeenCalled();
  });

  it("renaming an option keeps its id, so every lead's value survives", async () => {
    render(<FieldsEditor catalog={catalog} />);
    await userEvent.click(screen.getByRole("button", { name: "Edit Struggles" }));
    await userEvent.click(screen.getByRole("button", { name: "Rename Confidence" }));
    await userEvent.clear(screen.getByRole("textbox", { name: "Option name" }));
    await userEvent.type(screen.getByRole("textbox", { name: "Option name" }), "Self-confidence{Enter}");
    await userEvent.click(screen.getByRole("button", { name: "Save field" }));
    expect(fieldsClient.patch).toHaveBeenCalledWith("f-str", {
      options: [
        { id: "o1", label: "Self-confidence" },
        { id: "o2", label: "Career switch" },
      ],
    });
  });

  it("refuses a type change with the reason, and archives instead of deleting", async () => {
    render(<FieldsEditor catalog={catalog} />);
    await userEvent.click(screen.getByRole("button", { name: "Edit Struggles" }));
    expect(screen.getByLabelText("Type")).toBeDisabled();
    expect(
      screen.getByText("A field’s type can’t change once it exists. Make a new field instead."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /delete/i })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Archive Struggles" }));
    const ask = screen.getByRole("dialog", { name: "Archive Struggles?" });
    await userEvent.click(within(ask).getByRole("button", { name: "Archive field" }));
    expect(fieldsClient.archive).toHaveBeenCalledWith("f-str");
    expect(screen.queryByRole("button", { name: "Edit Struggles" })).not.toBeInTheDocument();
  });

  it("lets a built-in field be renamed, and nothing else", async () => {
    render(<FieldsEditor catalog={catalog} />);
    await userEvent.click(screen.getByRole("button", { name: "Edit Email" }));
    expect(screen.queryByRole("checkbox", { name: /needed/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Archive/ })).not.toBeInTheDocument();
    const name = screen.getByLabelText("Field name");
    await userEvent.clear(name);
    await userEvent.type(name, "Email address");
    await userEvent.click(screen.getByRole("button", { name: "Save field" }));
    expect(fieldsClient.patch).toHaveBeenCalledWith("f-email", { label: "Email address" });
  });

  it("shows the API's reason when a save is refused", async () => {
    vi.mocked(fieldsClient.patch).mockResolvedValueOnce({
      ok: false,
      status: 400,
      code: "DUPLICATE_OPTION",
      message: "Two options have the same name",
    });
    render(<FieldsEditor catalog={catalog} />);
    await userEvent.click(screen.getByRole("button", { name: "Edit Struggles" }));
    await userEvent.click(screen.getByRole("checkbox", { name: "Needed before a lead is saved" }));
    await userEvent.click(screen.getByRole("button", { name: "Save field" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Two options have the same name");
  });
});
