import { act, fireEvent, render } from "@testing-library/react";
import { useRef } from "react";
import { describe, expect, it } from "vitest";
import { useStickToBottom } from "./use-stick-to-bottom";

function Chat({ n }: { n: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useStickToBottom(ref, n);
  return <div ref={ref} data-testid="box" />;
}
/** jsdom has no layout: the box says how tall its content is, and how much shows. */
function sized(el: HTMLElement, content: number, shown = 300) {
  Object.defineProperty(el, "scrollHeight", { configurable: true, value: content });
  Object.defineProperty(el, "clientHeight", { configurable: true, value: shown });
}

/** A live conversation keeps the newest message in view, unless the person scrolled up to read (Autopilot A3). */
describe("useStickToBottom", () => {
  it("follows new messages while at the bottom", () => {
    const { getByTestId, rerender } = render(<Chat n={1} />);
    const box = getByTestId("box");
    sized(box, 900);
    rerender(<Chat n={2} />);
    expect(box.scrollTop).toBe(900);
  });

  it("leaves someone reading higher up where they are; back at the bottom, it follows again", () => {
    const { getByTestId, rerender } = render(<Chat n={1} />);
    const box = getByTestId("box");
    sized(box, 900);
    rerender(<Chat n={2} />);
    box.scrollTop = 100;
    fireEvent.scroll(box);
    sized(box, 1200);
    rerender(<Chat n={3} />);
    expect(box.scrollTop).toBe(100);
    box.scrollTop = 900;
    fireEvent.scroll(box);
    sized(box, 1500);
    rerender(<Chat n={4} />);
    expect(box.scrollTop).toBe(1500);
  });

  it("follows words typed into it, not only new messages", async () => {
    const { getByTestId } = render(<Chat n={1} />);
    const box = getByTestId("box");
    sized(box, 700);
    await act(async () => {
      box.appendChild(document.createTextNode("Here are a few"));
      await Promise.resolve();
    });
    expect(box.scrollTop).toBe(700);
  });
});
