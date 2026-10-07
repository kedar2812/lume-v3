import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { EMPTY_FILTERS } from "@/lib/leads/filters";
import { testCatalog } from "@/lib/leads/test-catalog";
import { fakeSession } from "@/server/session";
import { FilterBar } from "./FilterBar";

const session = fakeSession({ permissions: [{ key: "leads.view", scope: "all" }] });
const src = "0190e0c0-0000-7000-8000-00000000c5c5";

describe("FilterBar", () => {
  it("names an import's leads by their file, and takes the filter off with one press", async () => {
    const onChange = vi.fn();
    render(
      <FilterBar
        session={session}
        catalog={testCatalog()}
        filters={{ ...EMPTY_FILTERS, source: src }}
        onChange={onChange}
        contactsVisible
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Remove filter: From leads-march.csv" }));
    expect(onChange).toHaveBeenCalledWith(expect.not.objectContaining({ source: src }));
  });

  it("on a phone, one Filters button opens the menus and says how many filters are on", async () => {
    render(
      <FilterBar
        session={session}
        catalog={testCatalog()}
        filters={{ ...EMPTY_FILTERS, source: src }}
        onChange={vi.fn()}
        contactsVisible
      />,
    );
    const toggle = screen.getByRole("button", { name: "Filters · 1" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    const menus = document.getElementById(toggle.getAttribute("aria-controls")!)!;
    // The menus it folds away are the bar's own: the owner menu and More filters.
    expect(menus).toContainElement(screen.getByRole("button", { name: /More filters/ }));
    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(menus).toHaveAttribute("data-open");
  });

  it("still filters by a source the catalog doesn't name", () => {
    render(
      <FilterBar
        session={session}
        catalog={testCatalog({ sources: [] })}
        filters={{ ...EMPTY_FILTERS, source: src }}
        onChange={vi.fn()}
        contactsVisible
      />,
    );
    expect(screen.getByRole("button", { name: "Remove filter: From an import" })).toBeInTheDocument();
  });

  it("a lost reason on its own (a link or a view) shows its chip, and the chip takes it off", async () => {
    const onChange = vi.fn();
    const cat = testCatalog();
    const reason = cat.lostReasons[0]!;
    render(
      <FilterBar
        filters={{ ...EMPTY_FILTERS, lostReasonId: reason.id }}
        onChange={onChange}
        catalog={cat}
        session={session}
        contactsVisible
      />,
    );
    const chip = screen.getByRole("button", { name: new RegExp(`Lost · ${reason.label}`) });
    await userEvent.click(chip);
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ lostReasonId: undefined }));
  });
});
