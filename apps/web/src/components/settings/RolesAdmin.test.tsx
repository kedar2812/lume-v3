import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { testCatalog } from "@/lib/leads/test-catalog";
import { rolesClient, type PermissionDef, type Role } from "@/lib/settings/roles";
import { RolesAdmin } from "./RolesAdmin";

vi.mock("@/lib/settings/roles", () => ({
  rolesClient: { patch: vi.fn(), create: vi.fn(), clone: vi.fn(), remove: vi.fn(), setFieldAccess: vi.fn() },
}));

const catalog: PermissionDef[] = [
  { key: "leads.view", group: "Leads", label: "See leads", description: "", scoped: true },
];
const role = (over: Partial<Role>): Role => ({
  id: "r-sales",
  name: "Sales",
  description: "",
  color: "ok",
  grants: [{ key: "leads.view", scope: "own" }],
  fieldAccess: [],
  holders: 3,
  ...over,
});
const roles = [role({ id: "r-admin", name: "Admin", color: "accent", holders: 1 }), role({})];
const ok = <T,>(data: T) => ({ ok: true as const, status: 200, data });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(rolesClient.clone).mockResolvedValue(
    ok({ role: role({ id: "r-copy", name: "Sales copy", holders: 0 }) }),
  );
  vi.mocked(rolesClient.create).mockResolvedValue(
    ok({ role: role({ id: "r-new", name: "Setters", grants: [], holders: 0 }) }),
  );
  vi.mocked(rolesClient.remove).mockResolvedValue(ok(null));
});

describe("RolesAdmin", () => {
  it("lists roles with how many people hold each, and opens one to edit", async () => {
    render(<RolesAdmin roles={roles} catalog={catalog} fields={testCatalog().fields} />);
    expect(screen.getByRole("button", { name: /Sales.*3 people/ })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Sales.*3 people/ }));
    expect(screen.getByRole("heading", { name: "Sales" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("tab", { name: "Fields" }));
    expect(screen.getByRole("radio", { name: "Phone: Edit" })).toBeInTheDocument();
  });

  it("creates a role and duplicates one", async () => {
    render(<RolesAdmin roles={roles} catalog={catalog} fields={testCatalog().fields} />);
    await userEvent.type(screen.getByRole("textbox", { name: "New role" }), "Setters{Enter}");
    expect(rolesClient.create).toHaveBeenCalledWith({ name: "Setters", grants: [] });
    expect(await screen.findByRole("heading", { name: "Setters" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Sales.*3 people/ }));
    await userEvent.click(screen.getByRole("button", { name: "Duplicate Sales" }));
    expect(rolesClient.clone).toHaveBeenCalledWith("r-sales", "Sales copy");
  });

  it("deleting a role that people hold asks who they move to", async () => {
    render(<RolesAdmin roles={roles} catalog={catalog} fields={testCatalog().fields} />);
    await userEvent.click(screen.getByRole("button", { name: /Sales.*3 people/ }));
    await userEvent.click(screen.getByRole("button", { name: "Delete Sales" }));
    const ask = screen.getByRole("dialog", { name: "Delete Sales?" });
    const to = within(ask).getByLabelText("Move its 3 people to");
    expect(
      within(to)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["Choose a role", "Admin"]);
    expect(within(ask).getByRole("button", { name: "Delete role" })).toBeDisabled();
    await userEvent.selectOptions(to, "r-admin");
    await userEvent.click(within(ask).getByRole("button", { name: "Delete role" }));
    expect(rolesClient.remove).toHaveBeenCalledWith("r-sales", "r-admin");
    expect(screen.queryByRole("button", { name: /Sales.*3 people/ })).not.toBeInTheDocument();
  });
});
