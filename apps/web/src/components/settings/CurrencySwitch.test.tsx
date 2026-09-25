import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { settingsClient } from "@/lib/settings/client";
import { CurrencySwitch } from "./CurrencySwitch";

vi.mock("@/lib/settings/client", () => ({
  settingsClient: { quoteCurrency: vi.fn(), switchCurrency: vi.fn() },
}));

const quote = {
  from: "AED",
  to: "USD",
  rate: 0.2723,
  asOf: "2026-09-25T00:02:31.000Z",
  source: "open.er-api.com",
  affected: { leads: 42, products: 3, customFields: 0 },
};
const pickUsd = async () => {
  await userEvent.click(screen.getByRole("button", { name: "Change currency" }));
  await userEvent.click(screen.getByRole("button", { name: /^New currency/ }));
  await userEvent.type(screen.getByRole("combobox", { name: "Search currencies" }), "usd{Enter}");
};

beforeEach(() => vi.clearAllMocks());

describe("CurrencySwitch", () => {
  it("shows the business currency, the one every amount is in", () => {
    render(<CurrencySwitch current="AED" onSwitched={vi.fn()} onForbidden={vi.fn()} />);
    expect(screen.getByText("United Arab Emirates Dirham")).toBeInTheDocument();
    expect(screen.getByText("Every amount in LUME is in this currency.")).toBeInTheDocument();
  });

  it("quotes the live rate, shows what changes, and converts only after the admin confirms", async () => {
    vi.mocked(settingsClient.quoteCurrency).mockResolvedValue({ ok: true, status: 200, data: quote });
    vi.mocked(settingsClient.switchCurrency).mockResolvedValue({
      ok: true,
      status: 200,
      data: { currency: "USD", converted: { leads: 42, products: 3 } },
    });
    const onSwitched = vi.fn();
    render(<CurrencySwitch current="AED" onSwitched={onSwitched} onForbidden={vi.fn()} />);
    await pickUsd();
    const dialog = await screen.findByRole("dialog", { name: "Change the currency to US Dollar?" });
    expect(dialog).toHaveTextContent("1 AED = 0.2723 USD");
    expect(dialog).toHaveTextContent("42 lead values and 3 package prices will be converted");
    expect(dialog).toHaveTextContent("open.er-api.com, 25 Sep 2026");
    expect(settingsClient.switchCurrency).not.toHaveBeenCalled();
    await userEvent.click(within(dialog).getByRole("button", { name: "Convert to USD" }));
    expect(settingsClient.switchCurrency).toHaveBeenCalledWith({ from: "AED", to: "USD", rate: 0.2723 });
    expect(onSwitched).toHaveBeenCalledWith("USD");
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Every amount is now in US Dollar. 42 lead values and 3 package prices converted.",
    );
  });

  it("lets the admin type the rate when the live one isn't available", async () => {
    vi.mocked(settingsClient.quoteCurrency).mockResolvedValue({
      ok: false,
      status: 502,
      code: "RATES_UNAVAILABLE",
      message: "x",
    });
    vi.mocked(settingsClient.switchCurrency).mockResolvedValue({
      ok: true,
      status: 200,
      data: { currency: "USD", converted: { leads: 0, products: 0 } },
    });
    render(<CurrencySwitch current="AED" onSwitched={vi.fn()} onForbidden={vi.fn()} />);
    await pickUsd();
    expect(await screen.findByText(/live rate isn’t available/i)).toBeInTheDocument();
    const convert = screen.getByRole("button", { name: "Convert to USD" });
    expect(convert).toBeDisabled(); // no rate yet
    await userEvent.type(screen.getByLabelText("1 AED in USD"), "0.27");
    await userEvent.click(convert);
    expect(settingsClient.switchCurrency).toHaveBeenCalledWith({ from: "AED", to: "USD", rate: 0.27 });
  });

  it("uses a rate the admin corrects, and refuses one that makes no sense", async () => {
    vi.mocked(settingsClient.quoteCurrency).mockResolvedValue({ ok: true, status: 200, data: quote });
    vi.mocked(settingsClient.switchCurrency).mockResolvedValue({
      ok: true,
      status: 200,
      data: { currency: "USD", converted: { leads: 42, products: 3 } },
    });
    render(<CurrencySwitch current="AED" onSwitched={vi.fn()} onForbidden={vi.fn()} />);
    await pickUsd();
    const rate = await screen.findByLabelText("1 AED in USD");
    await userEvent.clear(rate);
    await userEvent.type(rate, "0");
    expect(screen.getByRole("button", { name: "Convert to USD" })).toBeDisabled();
    await userEvent.clear(rate);
    await userEvent.type(rate, "0.2725");
    await userEvent.click(screen.getByRole("button", { name: "Convert to USD" }));
    expect(settingsClient.switchCurrency).toHaveBeenCalledWith({ from: "AED", to: "USD", rate: 0.2725 });
  });

  it("explains when another admin switched the currency first", async () => {
    vi.mocked(settingsClient.quoteCurrency).mockResolvedValue({ ok: true, status: 200, data: quote });
    vi.mocked(settingsClient.switchCurrency).mockResolvedValue({
      ok: false,
      status: 409,
      code: "CURRENCY_CHANGED",
      message: "x",
    });
    const onSwitched = vi.fn();
    render(<CurrencySwitch current="AED" onSwitched={onSwitched} onForbidden={vi.fn()} />);
    await pickUsd();
    await userEvent.click(await screen.findByRole("button", { name: "Convert to USD" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The currency was just changed by someone else.",
    );
    expect(onSwitched).not.toHaveBeenCalled();
  });

  it("hands a refusal of access to the page", async () => {
    vi.mocked(settingsClient.quoteCurrency).mockResolvedValue({
      ok: false,
      status: 403,
      code: "FORBIDDEN",
      message: "x",
    });
    const onForbidden = vi.fn();
    render(<CurrencySwitch current="AED" onSwitched={vi.fn()} onForbidden={onForbidden} />);
    await pickUsd();
    expect(onForbidden).toHaveBeenCalled();
  });
});
