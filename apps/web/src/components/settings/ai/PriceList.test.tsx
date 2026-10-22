import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { PriceList, draftsOf, pricesOf, type PriceDraft } from "./PriceList";

const KITCHEN = {
  id: "0192a000-0000-7000-8000-000000000001",
  item: "Modular kitchen",
  price: 380000,
  unit: "per kitchen",
  notes: "",
};

function Harness({ start = [KITCHEN] }: { start?: (typeof KITCHEN)[] }) {
  const [rows, setRows] = useState<PriceDraft[]>(draftsOf(start, "INR"));
  const out = pricesOf(rows);
  return (
    <>
      <PriceList rows={rows} currency="INR" onChange={setRows} />
      <output data-testid="out">{JSON.stringify(out)}</output>
    </>
  );
}
const out = () => JSON.parse(screen.getByTestId("out").textContent!);

/** Settings → LUME AI's price list (Autopilot A1, Task 6): the only prices LUME AI may ever quote (§11). */
describe("the price list", () => {
  it("shows each price in the business currency, as people write it", () => {
    render(<Harness />);
    expect(screen.getByRole("textbox", { name: "Price for Modular kitchen" })).toHaveValue("3,80,000");
    expect(screen.getAllByText("INR").length).toBeGreaterThan(0);
  });

  it("adds, edits and removes rows", async () => {
    render(<Harness />);
    await userEvent.click(screen.getByRole("button", { name: "Add a price" }));
    await userEvent.type(screen.getByRole("textbox", { name: "What price 2 is for" }), "Design visit");
    await userEvent.type(screen.getByRole("textbox", { name: "Price for Design visit" }), "1,150.50");
    await userEvent.type(screen.getByRole("textbox", { name: "Unit for Design visit" }), "per visit");
    expect(out().prices.map((p: { item: string; price: number }) => [p.item, p.price])).toEqual([
      ["Modular kitchen", 380000],
      ["Design visit", 1150.5],
    ]);

    await userEvent.click(screen.getByRole("button", { name: "Remove Modular kitchen" }));
    expect(out().prices.map((p: { item: string }) => p.item)).toEqual(["Design visit"]);
    // The row leaves with its exit animation.
    await waitFor(() =>
      expect(screen.queryByRole("textbox", { name: "Price for Modular kitchen" })).toBeNull(),
    );
  });

  it("refuses a negative price in words, on its row", async () => {
    render(<Harness />);
    const price = screen.getByRole("textbox", { name: "Price for Modular kitchen" });
    await userEvent.clear(price);
    await userEvent.type(price, "-1");
    expect(out().problem).toBe("A price can't be below zero.");
    const row = screen.getByRole("group", { name: "Modular kitchen" });
    expect(within(row).getByRole("alert")).toHaveTextContent("A price can't be below zero.");
    expect(price).toHaveAttribute("aria-invalid", "true");
  });

  it("a row needs what it's for and a price", async () => {
    render(<Harness start={[]} />);
    expect(
      screen.getByText("No prices yet. LUME AI never quotes a price that isn't here."),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Add a price" }));
    expect(out().problem).toBe("Each price needs what it's for.");
    await userEvent.type(screen.getByRole("textbox", { name: "What price 1 is for" }), "Sofa");
    expect(out().problem).toBe("Each price needs its amount.");
  });
});
