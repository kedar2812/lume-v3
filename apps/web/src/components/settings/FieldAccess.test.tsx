import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { testCatalog } from "@/lib/leads/test-catalog";
import { rolesClient, type Role } from "@/lib/settings/roles";
import { FieldAccess } from "./FieldAccess";

vi.mock("@/lib/settings/roles", () => ({
  rolesClient: { patch: vi.fn(), create: vi.fn(), clone: vi.fn(), remove: vi.fn(), setFieldAccess: vi.fn() },
}));

const fields = testCatalog().fields;
const sales = (): Role => ({
  id: "r-sales",
  name: "Sales",
  description: "",
  color: "ok",
  grants: [],
  fieldAccess: [{ fieldId: "f-email", access: "view" }],
  holders: 3,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(rolesClient.setFieldAccess).mockImplementation(async (_id, entries) => ({
    ok: true,
    status: 200,
    data: { entries: entries.filter((e) => e.access !== "edit") },
  }));
});

describe("FieldAccess", () => {
  it("sets a field hidden, view-only or editable for the role, keeping the others", async () => {
    const onChange = vi.fn();
    render(<FieldAccess role={sales()} fields={fields} onChange={onChange} />);
    expect(screen.getByRole("radio", { name: "Email: View" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "Phone: Edit" })).toBeChecked();
    await userEvent.click(screen.getByRole("radio", { name: "Phone: Hidden" }));
    expect(rolesClient.setFieldAccess).toHaveBeenCalledWith("r-sales", [
      { fieldId: "f-email", access: "view" },
      { fieldId: "f-phone", access: "hidden" },
    ]);
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        fieldAccess: [
          { fieldId: "f-email", access: "view" },
          { fieldId: "f-phone", access: "hidden" },
        ],
      }),
    );
  });

  it("says the owner always sees everything, and the name can't be hidden", () => {
    render(<FieldAccess role={sales()} fields={fields} onChange={vi.fn()} />);
    expect(screen.getByText(/The owner always sees and edits every field/)).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Name: Hidden" })).toBeDisabled();
  });

  it("puts the choice back and explains a refusal", async () => {
    vi.mocked(rolesClient.setFieldAccess).mockResolvedValueOnce({
      ok: false,
      status: 403,
      code: "ESCALATION",
      message: "You can only give field access you have yourself",
    });
    render(<FieldAccess role={sales()} fields={fields} onChange={vi.fn()} />);
    await userEvent.click(screen.getByRole("radio", { name: "Email: Edit" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "You can only give field access you have yourself",
    );
    expect(screen.getByRole("radio", { name: "Email: View" })).toBeChecked();
  });
});
