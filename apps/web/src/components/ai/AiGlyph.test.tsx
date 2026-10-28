import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AiGlyph } from "./AiGlyph";

let reduced = false;
vi.mock("motion/react", async (orig) => ({
  ...(await orig<typeof import("motion/react")>()),
  useReducedMotion: () => reduced,
}));

describe("LUME AI's mark, The Loop", () => {
  it("each drawing has its own gradient, so two on a page never lose their colour", () => {
    const { container } = render(
      <>
        <AiGlyph />
        <AiGlyph size={24} />
      </>,
    );
    const ids = [...container.querySelectorAll("linearGradient")].map((g) => g.id);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    container
      .querySelectorAll("path")
      .forEach((p, i) => expect(p.getAttribute("stroke")).toBe(`url(#${ids[i]})`));
  });

  it("is decoration: hidden from screen readers, at the size asked", () => {
    const { container } = render(<AiGlyph size={20} />);
    const svg = container.querySelector("svg")!;
    expect(svg).toHaveAttribute("aria-hidden", "true");
    expect(svg).toHaveAttribute("width", "20");
  });
});

describe("the mark drawing itself (Autopilot A3, spec 2026-10-19 §1.4, §2)", () => {
  it("draws once when a run starts, or like a pen while LUME AI works", () => {
    reduced = false;
    const { container, rerender } = render(<AiGlyph draw="once" />);
    expect(container.querySelector("path")).toHaveAttribute("data-draw", "once");
    rerender(<AiGlyph draw="pen" />);
    expect(container.querySelector("path")).toHaveAttribute("data-draw", "pen");
    rerender(<AiGlyph />);
    expect(container.querySelector("path")).not.toHaveAttribute("data-draw");
  });

  // Drawn to nothing, the stroke's dashes start at 0: only the round cap shows, a dot.
  const dot = (p: Element | null) => /^0(px)?[ ,]/.test(p?.getAttribute("stroke-dasharray") ?? "");

  it("the sidebar's Loop starts whole: its first frame is the mark, never an empty stroke (2026-10-28)", () => {
    reduced = false;
    const { container } = render(<AiGlyph draw="loop" />);
    expect(container.querySelector("path")).toHaveAttribute("data-draw", "loop");
    expect(dot(container.querySelector("path"))).toBe(false);
  });

  it("reduced motion known only after the first frame: the mark is whole, never left a dot (2026-10-28)", () => {
    reduced = false;
    const { container, rerender } = render(<AiGlyph draw="pen" />);
    reduced = true;
    rerender(<AiGlyph draw="pen" />);
    expect(container.querySelector("path")).not.toHaveAttribute("data-draw");
    expect(dot(container.querySelector("path"))).toBe(false);
    reduced = false;
  });

  it("with reduced motion it rests, fully drawn", () => {
    reduced = true;
    const { container } = render(<AiGlyph draw="pen" />);
    expect(container.querySelector("path")).not.toHaveAttribute("data-draw");
    reduced = false;
  });
});
