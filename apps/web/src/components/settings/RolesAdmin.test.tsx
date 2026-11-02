import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { testCatalog } from "@/lib/leads/test-catalog";
import { rolesClient, type PermissionDef, type Role } from "@/lib/settings/roles";
import { RolesAdmin } from "./RolesAdmin";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
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
  uses: { invites: 0, templates: 0, views: 0 },
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
  vi.mocked(rolesClient.remove).mockResolvedValue(ok({ movedTo: null }));
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

  // Deleting a role is the top of the hierarchy (owner 2026-11-02): who holds it, what happens to them, the password.
  const people = [
    { id: "u-me", name: "Maya Kapoor", isOwner: true, roleIds: ["r-admin"] },
    { id: "u-rory", name: "Rory Reid", isOwner: false, roleIds: ["r-sales"] },
    { id: "u-sam", name: "Sam Okafor", isOwner: false, roleIds: ["r-sales"] },
    { id: "u-ana", name: "Ana Diaz", isOwner: false, roleIds: ["r-sales"] },
  ];
  const admin = { people, me: "u-me", twoStep: false, canDelete: true };

  it("only the owner, or someone who manages roles and people, sees Delete", async () => {
    render(<RolesAdmin roles={roles} catalog={catalog} fields={testCatalog().fields} />);
    await userEvent.click(screen.getByRole("button", { name: /Sales.*3 people/ }));
    expect(screen.queryByRole("button", { name: "Delete Sales" })).toBeNull();
  });

  it("people hold it: who they are, moved to another role, with the password; the button says exactly what", async () => {
    vi.mocked(rolesClient.remove).mockResolvedValue(ok({ movedTo: "r-admin" }));
    render(<RolesAdmin roles={roles} catalog={catalog} fields={testCatalog().fields} {...admin} />);
    await userEvent.click(screen.getByRole("button", { name: /Sales.*3 people/ }));
    await userEvent.click(screen.getByRole("button", { name: "Delete Sales" }));
    const sheet = screen.getByRole("dialog", { name: "Delete Sales" });
    expect(within(sheet).getByRole("list", { name: "Who holds Sales" }).children).toHaveLength(3);
    const go = within(sheet).getByRole("button", { name: "Delete Sales and move 3 people to Admin" });
    expect(go).toBeDisabled();
    await userEvent.type(within(sheet).getByLabelText("Password"), "s3cret-pass");
    await userEvent.click(go);
    expect(rolesClient.remove).toHaveBeenCalledWith("r-sales", {
      password: "s3cret-pass",
      people: { to: "role", roleId: "r-admin" },
    });
    expect(screen.queryByRole("button", { name: /Sales.*3 people/ })).not.toBeInTheDocument();
  });

  it("a new role for them, or their accounts deleted with their leads handed on; the owner's role only moves", async () => {
    render(<RolesAdmin roles={roles} catalog={catalog} fields={testCatalog().fields} {...admin} />);
    await userEvent.click(screen.getByRole("button", { name: /Sales.*3 people/ }));
    await userEvent.click(screen.getByRole("button", { name: "Delete Sales" }));
    let sheet = screen.getByRole("dialog", { name: "Delete Sales" });
    await userEvent.click(within(sheet).getByRole("radio", { name: /Delete their accounts/ }));
    await userEvent.selectOptions(within(sheet).getByLabelText("Who takes their leads"), "u-me");
    expect(sheet).toHaveTextContent(/can’t bring them back/);
    await userEvent.type(within(sheet).getByLabelText("Password"), "s3cret-pass");
    await userEvent.click(within(sheet).getByRole("button", { name: "Delete Sales and 3 accounts" }));
    expect(rolesClient.remove).toHaveBeenCalledWith("r-sales", {
      password: "s3cret-pass",
      people: { to: "delete", leads: { to: "person", userId: "u-me" } },
    });
    // The owner holds Admin: offboarding or deleting them isn't on offer.
    await userEvent.click(screen.getByRole("button", { name: /^Admin.*1 person/ }));
    await userEvent.click(screen.getByRole("button", { name: "Delete Admin" }));
    sheet = screen.getByRole("dialog", { name: "Delete Admin" });
    expect(within(sheet).getByRole("radio", { name: /Offboard them/ })).toBeDisabled();
    expect(within(sheet).getByRole("radio", { name: /Delete their account/ })).toBeDisabled();
  });

  it("a role nobody holds but invites, templates and a view still name: where they go, then the password", async () => {
    const desk = role({
      id: "r-desk",
      name: "Desk",
      holders: 0,
      uses: { invites: 1, templates: 2, views: 1 },
    });
    render(
      <RolesAdmin roles={[roles[0]!, desk]} catalog={catalog} fields={testCatalog().fields} {...admin} />,
    );
    await userEvent.click(screen.getByRole("button", { name: /Desk/ }));
    await userEvent.click(screen.getByRole("button", { name: "Delete Desk" }));
    const sheet = screen.getByRole("dialog", { name: "Delete Desk" });
    expect(sheet).toHaveTextContent("Nobody holds it.");
    await userEvent.selectOptions(
      within(sheet).getByLabelText("Role for its invites, templates and views"),
      "r-admin",
    );
    await userEvent.type(within(sheet).getByLabelText("Password"), "s3cret-pass");
    await userEvent.click(within(sheet).getByRole("button", { name: "Delete Desk" }));
    expect(rolesClient.remove).toHaveBeenCalledWith("r-desk", {
      password: "s3cret-pass",
      replacementRoleId: "r-admin",
    });
  });
});
