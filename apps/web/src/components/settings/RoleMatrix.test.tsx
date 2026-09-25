import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { rolesClient, type PermissionDef, type Role } from "@/lib/settings/roles";
import { RoleMatrix } from "./RoleMatrix";

vi.mock("@/lib/settings/roles", () => ({
  rolesClient: { patch: vi.fn(), create: vi.fn(), clone: vi.fn(), remove: vi.fn(), setFieldAccess: vi.fn() },
}));

const permissionCatalog = (): PermissionDef[] => [
  { key: "leads.view", group: "Leads", label: "See leads", description: "Open the leads list", scoped: true },
  {
    key: "leads.create",
    group: "Leads",
    label: "Create leads",
    description: "Add leads by hand",
    scoped: false,
  },
  { key: "leads.edit", group: "Leads", label: "Edit leads", description: "Change fields", scoped: true },
  {
    key: "templates.use",
    group: "Messaging",
    label: "Use templates",
    description: "Send from templates",
    scoped: false,
  },
  {
    key: "settings.manage",
    group: "Admin",
    label: "Change settings",
    description: "Business settings",
    scoped: false,
  },
];
const salesRole = (): Role => ({
  id: "r-sales",
  name: "Sales",
  description: "Works their own leads",
  color: "ok",
  grants: [
    { key: "leads.edit", scope: "own" },
    { key: "leads.view", scope: "own" },
    { key: "templates.use", scope: null },
  ],
  fieldAccess: [],
  holders: 3,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(rolesClient.patch).mockImplementation(async (id, patch) => ({
    ok: true,
    status: 200,
    data: { role: { ...salesRole(), ...patch } as Role },
  }));
});

describe("RoleMatrix", () => {
  it("grants a permission with a scope, and explains a refusal to grant what the editor doesn't hold", async () => {
    vi.mocked(rolesClient.patch).mockResolvedValueOnce({
      ok: false,
      status: 403,
      code: "ESCALATION",
      message: "You can only give access you have yourself",
    });
    render(<RoleMatrix role={salesRole()} catalog={permissionCatalog()} onChange={vi.fn()} />);
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "See leads: scope" }), "team");
    expect(rolesClient.patch).toHaveBeenCalledWith("r-sales", {
      grants: [
        { key: "leads.edit", scope: "own" },
        { key: "leads.view", scope: "team" },
        { key: "templates.use", scope: null },
      ],
    });
    expect(await screen.findByText("You can only give access you have yourself")).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "See leads: scope" })).toHaveDisplayValue("Own");
  });

  it("ticks a permission on with the narrowest scope, and off again", async () => {
    const onChange = vi.fn();
    render(<RoleMatrix role={salesRole()} catalog={permissionCatalog()} onChange={onChange} />);
    expect(screen.queryByRole("combobox", { name: "Create leads: scope" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("checkbox", { name: "Create leads" }));
    expect(rolesClient.patch).toHaveBeenLastCalledWith("r-sales", {
      grants: expect.arrayContaining([{ key: "leads.create", scope: null }]),
    });
    await userEvent.click(screen.getByRole("checkbox", { name: "Edit leads" }));
    expect(rolesClient.patch).toHaveBeenLastCalledWith("r-sales", {
      grants: expect.not.arrayContaining([expect.objectContaining({ key: "leads.edit" })]),
    });
    expect(onChange).toHaveBeenCalled();
  });

  it("gives a newly ticked scoped permission 'own', and groups permissions by area", async () => {
    const role = { ...salesRole(), grants: [] };
    render(<RoleMatrix role={role} catalog={permissionCatalog()} onChange={vi.fn()} />);
    expect(screen.getByRole("group", { name: "Leads" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Admin" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("checkbox", { name: "See leads" }));
    expect(rolesClient.patch).toHaveBeenCalledWith("r-sales", {
      grants: [{ key: "leads.view", scope: "own" }],
    });
  });

  it("sums the role up in plain words", () => {
    render(<RoleMatrix role={salesRole()} catalog={permissionCatalog()} onChange={vi.fn()} />);
    const summary = screen.getByRole("region", { name: "What Sales can do" });
    expect(within(summary).getByText("See leads")).toBeInTheDocument();
    expect(summary).toHaveTextContent("their own");
    expect(summary).toHaveTextContent("Use templates");
    expect(summary).not.toHaveTextContent("Change settings");
  });
});
