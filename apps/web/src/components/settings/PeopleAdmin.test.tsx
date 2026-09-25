import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { invitesClient, usersClient, type Invite, type UserRow } from "@/lib/settings/people";
import { fakeSession } from "@/server/session";
import { PeopleAdmin } from "./PeopleAdmin";

vi.mock("@/lib/settings/people", () => ({
  invitesClient: { create: vi.fn(), resend: vi.fn(), revoke: vi.fn() },
  usersClient: { setRoles: vi.fn(), disable: vi.fn(), enable: vi.fn(), endSessions: vi.fn() },
}));

const ok = <T,>(data: T) => ({ ok: true as const, status: 200, data });
const admin = () =>
  fakeSession({
    user: {
      id: "u-me",
      name: "Nupuur Patil",
      email: "n@x.test",
      isOwner: true,
      theme: "system",
      timezone: "Asia/Dubai",
    },
    permissions: [{ key: "users.manage", scope: null }],
  } as never);
const person = (over: Partial<UserRow>): UserRow => ({
  id: "u-riya",
  name: "Riya Sharma",
  email: "r@x.test",
  status: "active",
  isOwner: false,
  twoFactor: true,
  lastLoginAt: null,
  roles: [],
  ...over,
});
const riya = person({ roles: [{ id: "r-sales", name: "Sales" }] });
const tas = person({ id: "u-tas", name: "Tasneem Shaikh", email: "t@x.test" });
const roles = [
  { id: "r-sales", name: "Sales" },
  { id: "r-lead", name: "Team lead" },
];
const invite: Invite = {
  id: "i1",
  email: "b@x.test",
  name: "Bilal",
  roles: [{ id: "r-sales", name: "Sales" }],
  invitedBy: "Nupuur Patil",
  expiresAt: "2026-10-02T00:00:00Z",
  expired: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(invitesClient.create).mockResolvedValue(
    ok({
      invite: { id: "i2", email: "c@x.test", expiresAt: "2026-10-02T00:00:00Z" },
      url: "https://lume.test/i/abc",
    }),
  );
  vi.mocked(invitesClient.resend).mockResolvedValue(ok(null));
  vi.mocked(invitesClient.revoke).mockResolvedValue(ok(null));
  vi.mocked(usersClient.disable).mockResolvedValue(ok(null));
  vi.mocked(usersClient.enable).mockResolvedValue(ok(null));
  vi.mocked(usersClient.setRoles).mockResolvedValue(ok(null));
  vi.mocked(usersClient.endSessions).mockResolvedValue(ok(null));
});

describe("PeopleAdmin", () => {
  it("invites someone with a role, and lists open invites with resend and revoke", async () => {
    render(<PeopleAdmin users={[]} invites={[invite]} roles={roles} session={admin()} />);
    await userEvent.type(screen.getByLabelText("Email"), "c@x.test");
    await userEvent.type(screen.getByLabelText("Name"), "Chen");
    await userEvent.selectOptions(screen.getByLabelText("Role"), "r-sales");
    await userEvent.click(screen.getByRole("button", { name: "Send invite" }));
    expect(invitesClient.create).toHaveBeenCalledWith({
      email: "c@x.test",
      name: "Chen",
      roleIds: ["r-sales"],
    });
    expect(await screen.findByRole("status")).toHaveTextContent("Invite sent to c@x.test");
    expect(screen.getByRole("button", { name: "Resend invite to c@x.test" })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Resend invite to b@x.test" }));
    expect(invitesClient.resend).toHaveBeenCalledWith("i1");
    await userEvent.click(screen.getByRole("button", { name: "Revoke invite to b@x.test" }));
    expect(invitesClient.revoke).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Revoke" }));
    expect(invitesClient.revoke).toHaveBeenCalledWith("i1");
    expect(screen.queryByRole("button", { name: "Resend invite to b@x.test" })).not.toBeInTheDocument();
  });

  it("checks the invite before sending it", async () => {
    render(<PeopleAdmin users={[]} invites={[]} roles={roles} session={admin()} />);
    await userEvent.type(screen.getByLabelText("Email"), "not-an-email");
    await userEvent.click(screen.getByRole("button", { name: "Send invite" }));
    expect(screen.getByText("Enter an email address, like name@company.com")).toBeInTheDocument();
    expect(screen.getByText("Add their name")).toBeInTheDocument();
    expect(invitesClient.create).not.toHaveBeenCalled();
  });

  it("disabling someone asks what happens to their leads", async () => {
    render(<PeopleAdmin users={[riya, tas]} invites={[]} roles={roles} session={admin()} />);
    await userEvent.click(screen.getByRole("button", { name: "Disable Riya Sharma" }));
    const ask = screen.getByRole("dialog", { name: "Disable Riya Sharma?" });
    expect(ask).toHaveTextContent("Riya will be signed out everywhere");
    const to = within(ask).getByLabelText("Riya’s leads go to");
    expect(
      within(to)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["Leave them unassigned", "Tasneem Shaikh"]);
    await userEvent.selectOptions(to, "u-tas");
    await userEvent.click(within(ask).getByRole("button", { name: "Disable" }));
    expect(usersClient.disable).toHaveBeenCalledWith("u-riya", { reassignTo: "u-tas" });
    expect(await screen.findByRole("button", { name: "Enable Riya Sharma" })).toBeInTheDocument();
  });

  it("changes someone's role, and signs them out everywhere on request", async () => {
    render(<PeopleAdmin users={[riya]} invites={[]} roles={roles} session={admin()} />);
    await userEvent.selectOptions(screen.getByLabelText("Role for Riya Sharma"), "r-lead");
    expect(usersClient.setRoles).toHaveBeenCalledWith("u-riya", ["r-lead"]);
    await userEvent.click(screen.getByRole("button", { name: "Sign Riya Sharma out everywhere" }));
    expect(usersClient.endSessions).toHaveBeenCalledWith("u-riya");
    expect(await screen.findByRole("status")).toHaveTextContent("Riya is signed out everywhere");
  });

  it("never offers to change the owner or yourself", () => {
    const owner = person({ id: "u-owner", name: "Omar Owner", isOwner: true });
    const me = person({ id: "u-me", name: "Nupuur Patil" });
    render(<PeopleAdmin users={[owner, me]} invites={[]} roles={roles} session={admin()} />);
    expect(screen.queryByRole("button", { name: "Disable Omar Owner" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Role for Omar Owner")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Disable Nupuur Patil" })).not.toBeInTheDocument();
  });

  it("shows the API's reason when an invite is refused", async () => {
    vi.mocked(invitesClient.create).mockResolvedValueOnce({
      ok: false,
      status: 409,
      code: "ALREADY_MEMBER",
      message: "Someone with that email already uses LUME",
    });
    render(<PeopleAdmin users={[]} invites={[]} roles={roles} session={admin()} />);
    await userEvent.type(screen.getByLabelText("Email"), "r@x.test");
    await userEvent.type(screen.getByLabelText("Name"), "Riya");
    await userEvent.click(screen.getByRole("button", { name: "Send invite" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Someone with that email already uses LUME");
  });

  it("a refusal to hand out more access than you hold is explained, not treated as lost access", async () => {
    vi.mocked(usersClient.setRoles).mockResolvedValueOnce({
      ok: false,
      status: 403,
      code: "ESCALATION",
      message: "You can only give access you have yourself",
    });
    render(<PeopleAdmin users={[riya]} invites={[]} roles={roles} session={admin()} />);
    await userEvent.selectOptions(screen.getByLabelText("Role for Riya Sharma"), "r-lead");
    expect(await screen.findByRole("alert")).toHaveTextContent("You can only give access you have yourself");
    expect(
      screen.queryByRole("heading", { name: "Your access to this page changed" }),
    ).not.toBeInTheDocument();
    expect(screen.getByLabelText("Role for Riya Sharma")).toHaveValue("r-sales");
  });
});
