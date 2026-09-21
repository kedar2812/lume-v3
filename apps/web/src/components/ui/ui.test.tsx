import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Avatar, initials } from "./Avatar";
import { Button } from "./Button";
import { CheckCircle } from "./CheckCircle";
import { IconButton } from "./IconButton";
import { Odometer } from "./Odometer";
import { ProgressRing } from "./ProgressRing";
import { SegmentedControl } from "./SegmentedControl";
import { Switch } from "./Switch";

describe("Button", () => {
  it("exposes its variant and becomes busy (and inert) while loading", async () => {
    const onClick = vi.fn();
    render(
      <Button variant="whatsapp" loading onClick={onClick}>
        Send
      </Button>,
    );
    const b = screen.getByRole("button", { name: /send/i });
    expect(b).toHaveAttribute("data-variant", "whatsapp");
    expect(b).toHaveAttribute("aria-busy", "true");
    await userEvent.click(b);
    expect(onClick).not.toHaveBeenCalled();
  });
});

describe("IconButton", () => {
  it("is labelled for assistive tech", () => {
    render(<IconButton label="Notifications">🔔</IconButton>);
    expect(screen.getByRole("button", { name: "Notifications" })).toBeInTheDocument();
  });
});

describe("Avatar", () => {
  it("derives initials", () => {
    expect(initials("Aisha Khan")).toBe("AK");
    expect(initials("  riya  ")).toBe("RI");
    expect(initials("Mary Ann de la Cruz")).toBe("MC");
    render(<Avatar name="Tasneem" />);
    expect(screen.getByLabelText("Tasneem")).toHaveTextContent("TA");
  });
});

describe("SegmentedControl", () => {
  const opts = [
    { value: "a", label: "7D" },
    { value: "b", label: "30D" },
    { value: "c", label: "90D" },
  ] as const;

  it("is a radio group with arrow-key navigation", async () => {
    const onChange = vi.fn();
    render(<SegmentedControl label="Range" value="b" options={opts} onChange={onChange} />);
    expect(screen.getByRole("radiogroup", { name: "Range" })).toBeInTheDocument();
    const b = screen.getByRole("radio", { name: "30D" });
    expect(b).toHaveAttribute("aria-checked", "true");
    b.focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(onChange).toHaveBeenLastCalledWith("c");
    await userEvent.keyboard("{ArrowLeft}");
    expect(onChange).toHaveBeenLastCalledWith("a");
  });
});

describe("Switch / CheckCircle", () => {
  it("Switch toggles with click and Space", async () => {
    const onChange = vi.fn();
    render(<Switch checked={false} onChange={onChange} label="Compare" />);
    const s = screen.getByRole("switch", { name: "Compare" });
    await userEvent.click(s);
    expect(onChange).toHaveBeenLastCalledWith(true);
    s.focus();
    await userEvent.keyboard(" ");
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it("CheckCircle reports completion once", async () => {
    const onChange = vi.fn();
    render(<CheckCircle checked={false} onChange={onChange} label="Mark done" />);
    await userEvent.click(screen.getByRole("checkbox", { name: "Mark done" }));
    expect(onChange).toHaveBeenCalledWith(true);
  });
});

describe("Odometer / ProgressRing", () => {
  it("Odometer shows each digit on a strip and announces the whole value", () => {
    render(<Odometer value={42500} format={(n) => n.toLocaleString("en-US")} label="Revenue" />);
    const o = screen.getByLabelText("Revenue: 42,500");
    expect(o.querySelectorAll("[data-digit]")).toHaveLength(5);
    expect(o.querySelector('[data-digit="4"]')?.getAttribute("style")).toContain("translateY(-4em)");
  });

  it("ProgressRing clamps and reports progress", () => {
    render(<ProgressRing value={1.4} label="Cleared today" />);
    expect(screen.getByRole("progressbar", { name: "Cleared today" })).toHaveAttribute(
      "aria-valuenow",
      "100",
    );
  });
});
