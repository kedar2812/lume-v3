import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { settingsClient, type BusinessSettings } from "@/lib/settings/client";
import { BusinessForm } from "./BusinessForm";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh, push: vi.fn(), replace: vi.fn() }) }));
vi.mock("@/lib/settings/client", () => ({
  settingsClient: { get: vi.fn(), patch: vi.fn(), quoteCurrency: vi.fn(), switchCurrency: vi.fn() },
}));

const initial: BusinessSettings = {
  businessName: "Nupuur Coaching",
  timezone: "Asia/Dubai",
  currency: "AED",
  defaultCountry: "AE",
  weekStart: 1,
  industryPreset: "coaching",
};

beforeEach(() => vi.clearAllMocks());

describe("BusinessForm", () => {
  it("saves only what changed, and says so quietly", async () => {
    vi.mocked(settingsClient.patch).mockResolvedValue({
      ok: true,
      status: 200,
      data: { ...initial, businessName: "Nupuur Coaching Co", weekStart: 0 },
    });
    render(<BusinessForm initial={initial} />);
    const name = screen.getByLabelText("Business name");
    await userEvent.clear(name);
    await userEvent.type(name, "Nupuur Coaching Co");
    await userEvent.selectOptions(screen.getByLabelText("Week starts on"), "0");
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(settingsClient.patch).toHaveBeenCalledWith({ businessName: "Nupuur Coaching Co", weekStart: 0 });
    expect(await screen.findByRole("status")).toHaveTextContent("Saved");
    expect(refresh).toHaveBeenCalled(); // the business name shows in the sidebar
  });

  it("has nothing to save until something changes, and needs a name", async () => {
    render(<BusinessForm initial={initial} />);
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
    await userEvent.clear(screen.getByLabelText("Business name"));
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(screen.getByText("Give the business a name")).toBeInTheDocument();
    expect(settingsClient.patch).not.toHaveBeenCalled();
  });

  it("picks the leads' country from the searchable list", async () => {
    vi.mocked(settingsClient.patch).mockResolvedValue({
      ok: true,
      status: 200,
      data: { ...initial, defaultCountry: "IN" },
    });
    render(<BusinessForm initial={initial} />);
    await userEvent.click(screen.getByRole("button", { name: /^Most leads are in/ }));
    await userEvent.type(screen.getByRole("combobox", { name: "Search countries" }), "india{Enter}");
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(settingsClient.patch).toHaveBeenCalledWith({ defaultCountry: "IN" });
  });

  it("says access changed when a save is refused", async () => {
    vi.mocked(settingsClient.patch).mockResolvedValue({
      ok: false,
      status: 403,
      code: "FORBIDDEN",
      message: "x",
    });
    render(<BusinessForm initial={initial} />);
    await userEvent.type(screen.getByLabelText("Business name"), " Co");
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(
      await screen.findByRole("heading", { name: "Your access to this page changed" }),
    ).toBeInTheDocument();
  });
});
