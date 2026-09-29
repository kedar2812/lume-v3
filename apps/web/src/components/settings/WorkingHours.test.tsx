import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/lib/api";
import { WorkingHours } from "./WorkingHours";

vi.mock("@/lib/api", () => ({ api: { patch: vi.fn() } }));
const ok = <T,>(data: T) => ({ ok: true as const, status: 200, data });
const initial = { days: [1, 2, 3, 4, 5], start: "09:00", end: "18:00" };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.patch).mockResolvedValue(ok(null));
});

describe("working hours (3C Task 6)", () => {
  it("the week from the business's first day, in its own timezone", () => {
    render(<WorkingHours initial={initial} weekStart={1} timezone="Asia/Dubai" />);
    const days = screen.getAllByRole("checkbox").map((c) => c.getAttribute("aria-label"));
    expect(days).toEqual(["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]);
    expect(screen.getByRole("checkbox", { name: "Saturday" })).not.toBeChecked();
    expect(screen.getByText(/Dubai · UTC\+4/)).toBeInTheDocument();
  });

  it("saves the days in order, and the hours", async () => {
    render(<WorkingHours initial={initial} weekStart={1} timezone="Asia/Dubai" />);
    await userEvent.click(screen.getByRole("checkbox", { name: "Saturday" }));
    await userEvent.clear(screen.getByLabelText("From"));
    await userEvent.type(screen.getByLabelText("From"), "10:00");
    await userEvent.click(screen.getByRole("button", { name: "Save working hours" }));
    expect(api.patch).toHaveBeenCalledWith("/api/v1/settings", {
      workingHours: { days: [1, 2, 3, 4, 5, 6], start: "10:00", end: "18:00" },
    });
    expect(await screen.findByRole("status")).toHaveTextContent("Saved");
  });

  it("no days, or a day that ends before it starts, is refused before the server is asked", async () => {
    render(
      <WorkingHours initial={{ days: [1], start: "09:00", end: "18:00" }} weekStart={0} timezone="UTC" />,
    );
    await userEvent.click(screen.getByRole("checkbox", { name: "Monday" }));
    await userEvent.click(screen.getByRole("button", { name: "Save working hours" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Pick at least one working day");
    await userEvent.click(screen.getByRole("checkbox", { name: "Monday" }));
    await userEvent.clear(screen.getByLabelText("Until"));
    await userEvent.type(screen.getByLabelText("Until"), "08:00");
    await userEvent.click(screen.getByRole("button", { name: "Save working hours" }));
    expect(screen.getByRole("alert")).toHaveTextContent("The day has to end after it starts");
    expect(api.patch).not.toHaveBeenCalled();
  });
});
