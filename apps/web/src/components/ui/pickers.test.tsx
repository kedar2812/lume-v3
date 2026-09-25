import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { CountryPicker } from "./CountryPicker";
import { CurrencyPicker } from "./CurrencyPicker";
import { MoneyInput } from "./MoneyInput";

function Currency({ initial = "AED" }: { initial?: string }) {
  const [code, setCode] = useState(initial);
  return (
    <>
      <CurrencyPicker label="Currency" value={code} onChange={setCode} />
      <output data-testid="value">{code}</output>
    </>
  );
}
const list = () => screen.getByRole("listbox");
const firstOption = () => within(list()).getAllByRole("option")[0];

describe("CurrencyPicker", () => {
  it("names the currency, not just its code, and opens a searchable list", async () => {
    render(<Currency />);
    const button = screen.getByRole("button", { name: /^Currency/ });
    expect(button).toHaveAccessibleName("Currency: United Arab Emirates Dirham, AED");
    await userEvent.click(button);
    expect(screen.getByRole("combobox", { name: "Search currencies" })).toHaveFocus();
    expect(firstOption()).toHaveAccessibleName("United Arab Emirates Dirham AED"); // the current one first
  });

  it("finds a currency by name, code or symbol", async () => {
    render(<Currency />);
    await userEvent.click(screen.getByRole("button", { name: /^Currency/ }));
    const search = screen.getByRole("combobox", { name: "Search currencies" });
    await userEvent.type(search, "rupee");
    expect(firstOption()).toHaveAccessibleName("Indian Rupee INR");
    await userEvent.clear(search);
    await userEvent.type(search, "usd");
    expect(firstOption()).toHaveAccessibleName("US Dollar USD");
    await userEvent.clear(search);
    await userEvent.type(search, "€");
    expect(firstOption()).toHaveAccessibleName("Euro EUR");
  });

  it("picks with the keyboard and says what was picked", async () => {
    render(<Currency />);
    await userEvent.click(screen.getByRole("button", { name: /^Currency/ }));
    await userEvent.type(screen.getByRole("combobox", { name: "Search currencies" }), "pound{Enter}");
    expect(screen.getByTestId("value")).toHaveTextContent("GBP");
    expect(screen.getByRole("button", { name: /^Currency/ })).toHaveAccessibleName(
      "Currency: British Pound, GBP",
    );
    expect(screen.getByRole("button", { name: /^Currency/ })).toHaveFocus();
  });
});

describe("MoneyInput", () => {
  it("shows the business currency in front of the amount, as a fact rather than a choice", async () => {
    function Harness() {
      const [amount, setAmount] = useState("");
      return (
        <>
          <label htmlFor="m">Deal value</label>
          <MoneyInput id="m" amount={amount} currency="AED" onChange={setAmount} />
          <output data-testid="amount">{amount}</output>
        </>
      );
    }
    render(<Harness />);
    expect(screen.getByText("AED")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument(); // one currency across LUME: nothing to pick
    expect(screen.getByLabelText("Deal value")).toHaveAccessibleDescription("In United Arab Emirates Dirham");
    await userEvent.type(screen.getByLabelText("Deal value"), "4,500");
    expect(screen.getByTestId("amount")).toHaveTextContent("4,500");
  });
});

describe("CountryPicker", () => {
  it("finds a country by name and picks it", async () => {
    function Harness() {
      const [iso, setIso] = useState("AE");
      return (
        <>
          <CountryPicker label="Most leads are in" value={iso} onChange={setIso} />
          <output data-testid="iso">{iso}</output>
        </>
      );
    }
    render(<Harness />);
    const button = screen.getByRole("button", { name: /^Most leads are in/ });
    expect(button).toHaveAccessibleName("Most leads are in: United Arab Emirates");
    await userEvent.click(button);
    await userEvent.type(screen.getByRole("combobox", { name: "Search countries" }), "india{Enter}");
    expect(screen.getByTestId("iso")).toHaveTextContent("IN");
  });
});
