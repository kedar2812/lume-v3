import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/lib/api";
import { isNetwork, type AccessView, type RoleAccess } from "@/lib/settings/security";
import { AccessTab } from "./AccessTab";

vi.mock("@/lib/api", () => ({ api: { put: vi.fn() } }));
const ok = <T,>(data: T) => ({ ok: true as const, status: 200, data });

const sales: RoleAccess = { id: "r-sales", name: "Sales", people: 3, loginHours: null, ipAllowlist: null };
const lead: RoleAccess = { id: "r-lead", name: "Team lead", people: 1, loginHours: null, ipAllowlist: null };
const view: AccessView = {
  roles: [sales, lead],
  workingHours: { days: [1, 2, 3, 4, 5, 6], start: "09:00", end: "19:00" },
  timezone: "Asia/Dubai",
  weekStart: 1,
  yourIp: "86.98.40.12",
};
const echo = () =>
  vi
    .mocked(api.put)
    .mockImplementation(async (url, body) =>
      ok({ role: { ...sales, id: String(url).split("/").pop()!, ...(body as object) } }),
    );

beforeEach(() => vi.clearAllMocks());
const save = () => userEvent.click(screen.getByRole("button", { name: "Save changes" }));

describe("Settings → Security → Access limits (6A Task 7)", () => {
  it("lists every role with how many hold it; the owner is never limited", () => {
    render(<AccessTab initial={view} />);
    const roles = screen.getByRole("group", { name: "Roles" });
    expect(within(roles).getByRole("button", { name: /Sales 3 people/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(within(roles).getByRole("button", { name: /Team lead 1 person/ })).toBeInTheDocument();
    expect(screen.getByText("The owner is never limited.")).toBeInTheDocument();
  });

  it("business hours say the business's own hours, and save as following them", async () => {
    echo();
    render(<AccessTab initial={view} />);
    const hours = screen.getByRole("radio", { name: /Business hours Monday to Saturday, 09:00–19:00/ });
    expect(screen.queryByRole("button", { name: "Save changes" })).not.toBeInTheDocument();
    await userEvent.click(hours);
    await save();
    expect(api.put).toHaveBeenCalledWith("/api/v1/security/access/r-sales", {
      loginHours: { business: true, days: [1, 2, 3, 4, 5, 6], from: "09:00", to: "19:00" },
      ipAllowlist: null,
    });
  });

  it("custom days and hours save as chosen", async () => {
    echo();
    render(<AccessTab initial={view} />);
    await userEvent.click(screen.getByRole("radio", { name: /^Custom/ }));
    await userEvent.click(screen.getByRole("button", { name: /^Saturday/ }));
    await userEvent.selectOptions(screen.getByLabelText("From"), "08:00");
    await userEvent.selectOptions(screen.getByLabelText("To"), "18:30");
    await save();
    expect(api.put).toHaveBeenCalledWith("/api/v1/security/access/r-sales", {
      loginHours: { days: [1, 2, 3, 4, 5], from: "08:00", to: "18:30" },
      ipAllowlist: null,
    });
  });

  it("networks: an address that isn't one is refused in LUME's words; a good one is added", async () => {
    echo();
    render(<AccessTab initial={view} />);
    await userEvent.click(screen.getByRole("radio", { name: /Only these networks/ }));
    const field = screen.getByLabelText("Network address");
    await userEvent.type(field, "not an ip");
    expect(screen.getByText("That isn’t a network address")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add" })).toBeDisabled();
    await userEvent.clear(field);
    await userEvent.type(field, "94.200.12.0/24");
    await userEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(screen.getByText("94.200.12.0/24")).toBeInTheDocument();
    await save();
    expect(api.put).toHaveBeenCalledWith("/api/v1/security/access/r-sales", {
      loginHours: null,
      ipAllowlist: ["94.200.12.0/24"],
    });
  });

  it("Add this network adds where you are, once", async () => {
    render(<AccessTab initial={view} />);
    await userEvent.click(screen.getByRole("radio", { name: /Only these networks/ }));
    expect(screen.getByText(/You’re on/)).toHaveTextContent("You’re on 86.98.40.12 right now.");
    const here = screen.getByRole("button", { name: "Add this network" });
    await userEvent.click(here);
    expect(screen.getByText("86.98.40.12")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add this network" })).not.toBeInTheDocument();
    expect(screen.getByText("Where you are now")).toBeInTheDocument();
  });

  it("only-these-networks with none is refused before the server is asked", async () => {
    render(<AccessTab initial={view} />);
    await userEvent.click(screen.getByRole("radio", { name: /Only these networks/ }));
    await save();
    expect(api.put).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("Add at least one network, or choose Anywhere.");
  });

  it("limits that would sign you out: said in amber, with Add this network to hand (Review Focus 5)", async () => {
    vi.mocked(api.put).mockResolvedValue({
      ok: false,
      status: 409,
      code: "WOULD_LOCK_YOU_OUT",
      message: "Saving this would sign you out: you're on 86.98.40.12. Add this network first.",
    });
    render(<AccessTab initial={view} />);
    await userEvent.click(screen.getByRole("radio", { name: /Only these networks/ }));
    await userEvent.type(screen.getByLabelText("Network address"), "10.0.0.0/8");
    await userEvent.click(screen.getByRole("button", { name: "Add" }));
    await save();
    expect(await screen.findByRole("alert")).toHaveTextContent("Saving this would sign you out");
    expect(screen.getByRole("button", { name: "Add this network" })).toHaveFocus();
  });

  it("Discard puts it back as saved", async () => {
    render(<AccessTab initial={view} />);
    await userEvent.click(screen.getByRole("radio", { name: /^Custom/ }));
    await userEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(screen.getByRole("radio", { name: /^Any time/ })).toBeChecked();
    // The bar leaves on its spring.
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Save changes" })).not.toBeInTheDocument(),
    );
  });

  it("switching role with changes unsaved asks first, in the page", async () => {
    render(<AccessTab initial={view} />);
    await userEvent.click(screen.getByRole("radio", { name: /^Custom/ }));
    await userEvent.click(screen.getByRole("button", { name: /Team lead/ }));
    const ask = screen.getByRole("alertdialog", { name: "Discard changes to Sales?" });
    await userEvent.click(within(ask).getByRole("button", { name: "Keep editing" }));
    expect(screen.getByRole("button", { name: /Sales 3 people/ })).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(screen.getByRole("button", { name: /Team lead/ }));
    await userEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Discard" }));
    expect(screen.getByRole("heading", { name: "When can Team lead sign in?" })).toBeInTheDocument();
  });
});

describe("isNetwork", () => {
  it.each([
    ["86.98.40.12", true],
    ["94.200.12.0/24", true],
    ["2001:db8::/32", true],
    ["2001:db8::1", true],
    ["300.1.1.1", false],
    ["1.2.3.4/33", false],
    ["office", false],
    ["", false],
  ])("%s → %s", (x, want) => expect(isNetwork(x)).toBe(want));
});
