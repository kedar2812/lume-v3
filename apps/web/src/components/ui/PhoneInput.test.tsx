import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { PhoneInput } from "./PhoneInput";

function Harness({ initial = "", onValue = vi.fn() }: { initial?: string; onValue?: (v: string) => void }) {
  const [value, setValue] = useState(initial);
  return (
    <>
      <label htmlFor="p">Phone</label>
      <PhoneInput
        id="p"
        value={value}
        defaultCountry="AE"
        onChange={(v) => {
          setValue(v);
          onValue(v);
        }}
      />
      <output data-testid="value">{value}</output>
    </>
  );
}
const country = () => screen.getByRole("button", { name: /^Country code/ });
const value = () => screen.getByTestId("value").textContent;

describe("PhoneInput", () => {
  it("starts on the business country and puts its code in front of what is typed", async () => {
    render(<Harness />);
    expect(country()).toHaveAccessibleName("Country code: United Arab Emirates +971");
    expect(country().querySelector("img")).toHaveAttribute("src", "/flags/AE.svg"); // decorative: the label names it
    await userEvent.type(screen.getByLabelText("Phone"), "050 123 4567");
    expect(value()).toBe("+971501234567"); // the typed trunk zero is dropped
    expect(screen.getByLabelText("Phone")).toHaveValue("050 123 4567"); // what they typed stays
  });

  it("finds a country by name or by code, and picking it goes back to the number", async () => {
    render(<Harness />);
    await userEvent.type(screen.getByLabelText("Phone"), "98200 12345");
    await userEvent.click(country());
    const search = screen.getByRole("combobox", { name: "Search countries" });
    expect(search).toHaveFocus();
    await userEvent.type(search, "ind");
    const list = screen.getByRole("listbox", { name: "Countries" });
    expect(within(list).getAllByRole("option")[0]).toHaveAccessibleName("India +91");
    await userEvent.clear(search);
    await userEvent.type(search, "+44");
    expect(within(list).getAllByRole("option")[0]).toHaveAccessibleName(/United Kingdom \+44/);
    await userEvent.clear(search);
    await userEvent.type(search, "india");
    await userEvent.click(within(list).getByRole("option", { name: "India +91" }));
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(country()).toHaveAccessibleName("Country code: India +91");
    expect(screen.getByLabelText("Phone")).toHaveFocus();
    expect(value()).toBe("+919820012345");
  });

  it("searches by country name and by number alike, however they're typed", async () => {
    render(<Harness />);
    await userEvent.click(country());
    const search = screen.getByRole("combobox", { name: "Search countries" });
    expect(search).toHaveAttribute("placeholder", "Country name or code, like India or 91");
    const first = () => within(screen.getByRole("listbox")).getAllByRole("option")[0];
    for (const [query, expected] of [
      ["india", "India +91"],
      ["IND", "India +91"],
      ["91", "India +91"],
      ["+91", "India +91"],
      ["0091", "India +91"],
      ["india 91", "India +91"],
      ["91 ind", "India +91"],
      ["971501234567", "United Arab Emirates +971"], // a whole number finds its country
      ["+44 20 7946", "United Kingdom +44"],
      ["united 44", "United Kingdom +44"],
    ] as const) {
      await userEvent.clear(search);
      await userEvent.type(search, query);
      expect(first(), query).toHaveAccessibleName(expected);
    }
  });

  it("works from the keyboard: arrows choose, Enter picks, Escape closes without picking", async () => {
    render(<Harness />);
    await userEvent.click(country());
    await userEvent.type(screen.getByRole("combobox", { name: "Search countries" }), "united");
    await userEvent.keyboard("{ArrowDown}{Enter}");
    expect(country()).toHaveAccessibleName(/^Country code: United /);
    expect(country()).not.toHaveAccessibleName(/Arab Emirates/);
    const picked = country().getAttribute("aria-label");
    await userEvent.click(country());
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(country()).toHaveFocus();
    expect(country()).toHaveAttribute("aria-label", picked);
  });

  it("floats the list above the page, so a scrolling table or drawer can't clip it", async () => {
    const { container } = render(
      <div style={{ overflow: "auto" }}>
        <Harness />
      </div>,
    );
    await userEvent.click(country());
    const list = screen.getByRole("listbox", { name: "Countries" });
    expect(container.contains(list)).toBe(false);
    expect(list.closest("[data-search-panel]")).toHaveStyle({ position: "fixed" });
    await userEvent.pointer({ target: document.body, keys: "[MouseLeft]" });
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("says so when nothing matches the search", async () => {
    render(<Harness />);
    await userEvent.click(country());
    await userEvent.type(screen.getByRole("combobox", { name: "Search countries" }), "zzzz");
    expect(screen.getByText("No country matches “zzzz”")).toBeInTheDocument();
  });

  it("reads the country out of a pasted international number", async () => {
    render(<Harness />);
    await userEvent.click(screen.getByLabelText("Phone"));
    await userEvent.paste("+91 98200 12345");
    expect(country()).toHaveAccessibleName("Country code: India +91");
    expect(screen.getByLabelText("Phone")).toHaveValue("9820012345");
    expect(value()).toBe("+919820012345");
  });

  it("shows a saved number split into its country and the rest", () => {
    render(<Harness initial="+447946000000" />);
    expect(country()).toHaveAccessibleName("Country code: United Kingdom +44");
    expect(screen.getByLabelText("Phone")).toHaveValue("7946000000");
  });

  it("leaves the number empty until something is typed", async () => {
    const onValue = vi.fn();
    render(<Harness onValue={onValue} />);
    await userEvent.click(country());
    await userEvent.click(screen.getByRole("option", { name: "India +91" }));
    expect(value()).toBe("");
  });
});
