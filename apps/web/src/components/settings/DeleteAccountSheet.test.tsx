import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { accountClient } from "@/lib/settings/account";
import { usersClient, type OffboardPreview } from "@/lib/settings/people";
import { DeleteAccountSheet } from "./DeleteAccountSheet";

vi.mock("@/lib/settings/account", () => ({ accountClient: { deletePreview: vi.fn(), deleteMe: vi.fn() } }));
vi.mock("@/lib/settings/people", () => ({ usersClient: { offboarding: vi.fn(), deleteAccount: vi.fn() } }));
const ok = <T,>(data: T) => ({ ok: true as const, status: 200, data });
const preview = (o: Partial<OffboardPreview> = {}): OffboardPreview =>
  ({
    person: { id: "u1", name: "Rory Reid", status: "active" },
    sessions: 1,
    leads: { total: 3, open: 3 },
    teams: [],
    people: [{ id: "u2", name: "Sam Okafor" }],
    calendar: null,
    last30: { reveals: 0, leadsOpened: 0, exports: 0, alerts: 0, usualPerDay: 0, busiest: null },
    ...o,
  }) as OffboardPreview;

beforeEach(() => vi.clearAllMocks());

/** Deleting an account (owner 2026-11-02): who takes the leads, the password twice, and that it can't be undone. */
describe("DeleteAccountSheet", () => {
  it("my own: the leads, the password twice, the plain warning; the button only when they're the same", async () => {
    vi.mocked(accountClient.deletePreview).mockResolvedValue(ok(preview()) as never);
    vi.mocked(accountClient.deleteMe).mockResolvedValue(ok(null) as never);
    const onDeleted = vi.fn();
    render(
      <DeleteAccountSheet
        self
        personId="u1"
        personName="Rory Reid"
        twoStep={false}
        onClose={vi.fn()}
        onDeleted={onDeleted}
      />,
    );
    expect(await screen.findByRole("heading", { name: "Delete your account" })).toBeInTheDocument();
    expect(screen.getByText("Who takes your 3 leads")).toBeInTheDocument();
    expect(screen.getByText(/can’t bring it back/)).toBeInTheDocument();
    const go = screen.getByRole("button", { name: "Delete my account" });
    expect(go).toBeDisabled();
    await userEvent.click(screen.getByRole("radio", { name: /Give them all to one person/ }));
    await userEvent.type(screen.getByLabelText("Password"), "s3cret-pass");
    await userEvent.type(screen.getByLabelText("The same password again"), "s3cret-pas");
    expect(screen.getByRole("alert")).toHaveTextContent("The two passwords aren’t the same.");
    expect(go).toBeDisabled();
    await userEvent.type(screen.getByLabelText("The same password again"), "s");
    expect(go).toBeEnabled();
    await userEvent.click(go);
    expect(accountClient.deleteMe).toHaveBeenCalledWith({
      leads: { to: "person", userId: "u2" },
      password: "s3cret-pass",
      passwordAgain: "s3cret-pass",
    });
    expect(onDeleted).toHaveBeenCalled();
  });

  it("someone else's: the admin's password once; a refusal said in words, nothing deleted", async () => {
    vi.mocked(usersClient.offboarding).mockResolvedValue(
      ok(preview({ leads: { total: 0, open: 0 } })) as never,
    );
    vi.mocked(usersClient.deleteAccount).mockResolvedValue({
      ok: false,
      status: 400,
      message: "That password isn't right",
    } as never);
    const onDeleted = vi.fn();
    render(
      <DeleteAccountSheet
        self={false}
        personId="u1"
        personName="Rory Reid"
        twoStep={false}
        onClose={vi.fn()}
        onDeleted={onDeleted}
      />,
    );
    expect(await screen.findByText("Rory has no leads to hand on")).toBeInTheDocument();
    expect(screen.queryByLabelText("The same password again")).toBeNull();
    await userEvent.type(screen.getByLabelText("Your password"), "admin-pass");
    await userEvent.click(screen.getByRole("button", { name: "Delete Rory’s account" }));
    expect(usersClient.deleteAccount).toHaveBeenCalledWith("u1", {
      leads: { to: "none" },
      password: "admin-pass",
    });
    expect(await screen.findByRole("alert")).toHaveTextContent("That password isn't right");
    expect(onDeleted).not.toHaveBeenCalled();
  });
});
