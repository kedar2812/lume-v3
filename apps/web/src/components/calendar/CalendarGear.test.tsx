import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BACK_KEY, CalendarGear, backToCalendar } from "./CalendarGear";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, replace: vi.fn(), prefetch: vi.fn() }) }));

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  window.history.replaceState(null, "", "/calendar?view=week&d=2026-10-08&m=m1");
});

describe("the Calendar's gear", () => {
  it("opens Settings → Calendar and remembers the exact Calendar view to come back to", async () => {
    render(<CalendarGear />);
    await userEvent.click(screen.getByRole("button", { name: "Calendar settings" }));
    expect(sessionStorage.getItem(BACK_KEY)).toBe("/calendar?view=week&d=2026-10-08&m=m1");
    expect(push).toHaveBeenCalledWith("/settings/calendar");
  });

  it("the way back is only ever a Calendar address", () => {
    sessionStorage.setItem(BACK_KEY, "/calendar?view=week");
    expect(backToCalendar()).toBe("/calendar?view=week");
    for (const bad of ["https://evil.example/calendar", "//evil.example", "/settings/people", "/calendarx"]) {
      sessionStorage.setItem(BACK_KEY, bad);
      expect(backToCalendar()).toBe("/calendar");
    }
    sessionStorage.clear();
    expect(backToCalendar()).toBe("/calendar");
  });
});
