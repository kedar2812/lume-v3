import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { roving } from "./roving";

function Tabs() {
  const [on, setOn] = useState("a");
  return (
    <div role="tablist" aria-label="Show" onKeyDown={(e) => roving(e, "tab")}>
      {["a", "b", "c"].map((id) => (
        <button
          key={id}
          type="button"
          role="tab"
          aria-selected={on === id}
          tabIndex={on === id ? 0 : -1}
          onClick={() => setOn(id)}
        >
          {id.toUpperCase()}
        </button>
      ))}
    </div>
  );
}

describe("keyboard paths through tabs and radio groups (Phase 9 Task 6)", () => {
  it("one Tab stop; the arrows move and choose, wrapping; Home and End go to the ends", async () => {
    render(
      <>
        <Tabs />
        <button type="button">After</button>
      </>,
    );
    await userEvent.tab();
    expect(screen.getByRole("tab", { name: "A" })).toHaveFocus();
    await userEvent.keyboard("{ArrowRight}");
    expect(screen.getByRole("tab", { name: "B" })).toHaveFocus();
    expect(screen.getByRole("tab", { name: "B" })).toHaveAttribute("aria-selected", "true");
    await userEvent.keyboard("{ArrowRight}{ArrowRight}");
    expect(screen.getByRole("tab", { name: "A" })).toHaveAttribute("aria-selected", "true");
    await userEvent.keyboard("{End}");
    expect(screen.getByRole("tab", { name: "C" })).toHaveFocus();
    await userEvent.keyboard("{Home}{ArrowLeft}");
    expect(screen.getByRole("tab", { name: "C" })).toHaveAttribute("aria-selected", "true");
    await userEvent.tab();
    expect(screen.getByRole("button", { name: "After" })).toHaveFocus();
  });
});
