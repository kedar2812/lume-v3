import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NearLimitNotice } from "@/components/security/NearLimitNotice";
import { api } from "@/lib/api";
import { leadsClient } from "@/lib/leads/client";
import { noteNearLimit, resetNearLimitForTests } from "./near-limit";

vi.mock("@/lib/api", () => ({ api: { get: vi.fn(), post: vi.fn() } }));
const ok = <T,>(data: T) => ({ ok: true as const, status: 200, data });

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  resetNearLimitForTests();
});

describe("the near-limit notice (6A)", () => {
  it("says once, calmly, that admins hear about unusual activity — no numbers", async () => {
    render(<NearLimitNotice />);
    expect(screen.queryByText(/opened a lot of contacts/)).not.toBeInTheDocument();
    act(() => noteNearLimit());
    expect(screen.getByText("You’ve opened a lot of contacts this hour")).toBeInTheDocument();
    expect(screen.getByText("LUME tells your admins when activity looks unusual.")).toBeInTheDocument();
    expect(screen.getByRole("note")).not.toHaveTextContent(/\d/);
    await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    await waitFor(() => expect(screen.queryByText(/opened a lot of contacts/)).not.toBeInTheDocument());
  });

  it("only once an hour", () => {
    act(() => noteNearLimit());
    const { unmount } = render(<NearLimitNotice />);
    expect(screen.getByRole("note")).toBeInTheDocument();
    unmount();
    act(() => noteNearLimit());
    render(<NearLimitNotice />);
    expect(screen.queryByRole("note")).not.toBeInTheDocument();
  });

  it("is raised by a reveal, or a lead opened, that comes back near the limit", async () => {
    render(<NearLimitNotice />);
    vi.mocked(api.post).mockResolvedValue(
      ok({ phone: "+971 50 111 2233", email: null, instagram: null, nearLimit: false }),
    );
    await act(async () => void (await leadsClient.reveal("l1")));
    expect(screen.queryByRole("note")).not.toBeInTheDocument();
    vi.mocked(api.get).mockResolvedValue(ok({ lead: { id: "l1" }, watch: { nearLimit: true } }));
    await act(async () => void (await leadsClient.get("l1")));
    expect(screen.getByRole("note")).toBeInTheDocument();
  });
});
