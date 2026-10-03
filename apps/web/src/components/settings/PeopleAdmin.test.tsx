import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { invitesClient, usersClient, type Invite, type UserRow } from "@/lib/settings/people";
import { fakeSession } from "@/server/session";
import { securityClient } from "@/lib/settings/security";
import { PeopleAdmin } from "./PeopleAdmin";

vi.mock("@/lib/settings/people", () => ({
  invitesClient: { create: vi.fn(), resend: vi.fn(), revoke: vi.fn() },
  usersClient: { setRoles: vi.fn(), disable: vi.fn(), enable: vi.fn(), endSessions: vi.fn() },
}));

vi.mock("@/lib/settings/security", () => ({ securityClient: { restorePerson: vi.fn() } }));
// The Offboard sheet has its own tests (OffboardSheet.test.tsx): here it only says who it's for, and finishes.
vi.mock("./OffboardSheet", () => ({
  OffboardSheet: ({ personId, onDone }: { personId: string; onDone: (o: unknown) => void }) => (
    <div role="dialog" aria-label={`Offboard sheet for ${personId}`}>
      <button
        type="button"
        onClick={() => onDone({ sessions: 1, leads: { to: "none", moved: 3 }, calendar: null })}
      >
        Finish
      </button>
    </div>
  ),
}));

const ok = <T,>(data: T) => ({ ok: true as const, status: 200, data });
const admin = () =>
  fakeSession({
    user: {
      id: "u-me",
      name: "Maya Kapoor",
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
const tas = person({ id: "u-tas", name: "Leila Haddad", email: "t@x.test" });
const roles = [
  { id: "r-sales", name: "Sales" },
  { id: "r-lead", name: "Team lead" },
];
const invite: Invite = {
  id: "i1",
  email: "b@x.test",
  name: "Bilal",
  roles: [{ id: "r-sales", name: "Sales" }],
  invitedBy: "Maya Kapoor",
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
    // No role is picked for you: defaulting to the first (often Admin) could hand out full control.
    expect(screen.getByLabelText("Role")).toHaveValue("");
    expect(screen.getByText("Choose what they can do")).toBeInTheDocument();
    expect(invitesClient.create).not.toHaveBeenCalled();
  });

  it("offboarding someone opens the Offboard sheet; once done they show as disabled (6C)", async () => {
    render(<PeopleAdmin users={[riya, tas]} invites={[]} roles={roles} session={admin()} />);
    expect(screen.queryByRole("button", { name: "Disable Riya Sharma" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Offboard Riya Sharma" }));
    const sheet = screen.getByRole("dialog", { name: "Offboard sheet for u-riya" });
    await userEvent.click(within(sheet).getByRole("button", { name: "Finish" }));
    expect(await screen.findByRole("button", { name: "Enable Riya Sharma" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Riya is offboarded. 3 leads handed on.");
  });

  it("opens the Offboard sheet on arrival from an alert (?offboard=), never for the owner or yourself", () => {
    const { unmount } = render(
      <PeopleAdmin users={[riya, tas]} invites={[]} roles={roles} session={admin()} offboard="u-riya" />,
    );
    expect(screen.getByRole("dialog", { name: "Offboard sheet for u-riya" })).toBeInTheDocument();
    unmount();
    const me = person({ id: "u-me", name: "Maya Kapoor" });
    render(<PeopleAdmin users={[me]} invites={[]} roles={roles} session={admin()} offboard="u-me" />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
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
    const me = person({ id: "u-me", name: "Maya Kapoor" });
    render(<PeopleAdmin users={[owner, me]} invites={[]} roles={roles} session={admin()} />);
    expect(screen.queryByRole("button", { name: "Offboard Omar Owner" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Role for Omar Owner")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Offboard Maya Kapoor" })).not.toBeInTheDocument();
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
    await userEvent.selectOptions(screen.getByLabelText("Role"), "r-sales");
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

  it("6A: a paused person says so, and someone who manages security can restore them", async () => {
    vi.mocked(securityClient.restorePerson).mockResolvedValue(ok(undefined));
    const sec = fakeSession({
      user: {
        id: "u-me",
        name: "Maya Kapoor",
        email: "n@x.test",
        isOwner: true,
        theme: "system",
        timezone: "Asia/Dubai",
      },
      permissions: [
        { key: "users.manage", scope: null },
        { key: "security.manage", scope: null },
      ],
    } as never);
    render(
      <PeopleAdmin users={[person({ status: "suspended" })]} invites={[]} roles={roles} session={sec} />,
    );
    const row = screen.getByText("Riya Sharma").closest("li")!;
    expect(within(row).getByText("Paused")).toBeInTheDocument();
    expect(within(row).queryByRole("button", { name: "Enable Riya Sharma" })).not.toBeInTheDocument();
    await userEvent.click(within(row).getByRole("button", { name: "Restore access for Riya Sharma" }));
    expect(securityClient.restorePerson).toHaveBeenCalledWith("u-riya");
    expect(await screen.findByText("Riya can sign in again.")).toBeInTheDocument();
    expect(within(row).queryByText("Paused")).not.toBeInTheDocument();
  });

  it("6A: without security, a paused person can't be restored from People", () => {
    // Not the owner (who can do everything): someone who manages people only.
    const peopleOnly = fakeSession({
      user: {
        id: "u-me",
        name: "Ade Admin",
        email: "a@x.test",
        isOwner: false,
        theme: "system",
        timezone: "Asia/Dubai",
      },
      permissions: [{ key: "users.manage", scope: null }],
    } as never);
    render(
      <PeopleAdmin
        users={[person({ status: "suspended" })]}
        invites={[]}
        roles={roles}
        session={peopleOnly}
      />,
    );
    const row = screen.getByText("Riya Sharma").closest("li")!;
    expect(within(row).getByText("Paused")).toBeInTheDocument();
    expect(within(row).queryByRole("button", { name: /Restore access/ })).not.toBeInTheDocument();
  });
});
