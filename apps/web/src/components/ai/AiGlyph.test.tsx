import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AiGlyph } from "./AiGlyph";

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
