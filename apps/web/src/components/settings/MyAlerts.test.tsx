import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PREFERENCES_DEFAULTS } from "@lume/core/shared";
import { MyAlerts } from "./MyAlerts";

describe("My account → Notifications: the morning email (bug hunt 2026-11-17)", () => {
  it("offered only where the business sends it", () => {
    const { unmount } = render(<MyAlerts initial={PREFERENCES_DEFAULTS} digestOn />);
    expect(screen.getByRole("switch", { name: "Morning email" })).toBeInTheDocument();
    unmount();
    render(<MyAlerts initial={PREFERENCES_DEFAULTS} digestOn={false} />);
    expect(screen.queryByRole("switch", { name: "Morning email" })).toBeNull();
    expect(screen.getByText(/The morning email is switched off for this business/)).toBeInTheDocument();
  });
});
