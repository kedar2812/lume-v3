import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadSheets } from "./sheet-load";
import { SheetView } from "./SheetView";

vi.mock("./sheet-load", () => ({ loadSheets: vi.fn() }));

beforeEach(() => vi.clearAllMocks());

describe("a spreadsheet in LUME's viewer (plan 2026-10-20-media-tab, Task 8)", () => {
  it("shows the first sheet as a table, and the tabs switch sheets", async () => {
    vi.mocked(loadSheets).mockResolvedValue([
      { name: "Homes", header: ["Package", "Price"], rows: [["Design consult", "2,500"]], numeric: [false, true], total: 1 },
      { name: "Offices", header: ["Package", "Per sq ft"], rows: [["Fit-out", "1,150"]], numeric: [false, true], total: 1 },
    ]);
    render(<SheetView src="/x" name="Prices.xlsx" />);
    const table = await screen.findByRole("table", { name: "Homes" });
    expect(within(table).getAllByRole("columnheader").map((c) => c.textContent)).toEqual(["Package", "Price"]);
    expect(within(table).getByRole("cell", { name: "2,500" })).toHaveAttribute("data-num");
    const tabs = screen.getByRole("tablist", { name: "Sheets" });
    expect(within(tabs).getByRole("tab", { name: "Homes" })).toHaveAttribute("aria-selected", "true");
    await userEvent.click(within(tabs).getByRole("tab", { name: "Offices" }));
    expect(screen.getByRole("table", { name: "Offices" })).toHaveTextContent("Fit-out");
  });

  it("a huge sheet shows its first 2,000 rows and says how many there are", async () => {
    vi.mocked(loadSheets).mockResolvedValue([
      {
        name: "Leads",
        header: ["Lead"],
        rows: Array.from({ length: 2000 }, (_, i) => [`Lead ${i + 1}`]),
        numeric: [false],
        total: 12_431,
      },
    ]);
    render(<SheetView src="/x" name="Leads.xlsx" />);
    expect(await screen.findByText("Showing the first 2,000 rows of 12,431.")).toBeInTheDocument();
  });

  it("one LUME can't read says so in plain words", async () => {
    vi.mocked(loadSheets).mockRejectedValue(new Error("Unsupported file"));
    render(<SheetView src="/x" name="Prices.xls" />);
    expect(await screen.findByText("LUME couldn't read this spreadsheet. It may be damaged or locked with a password.")).toBeInTheDocument();
  });
});
