import { afterEach, describe, expect, it } from "vitest";
import { guardNumberWheel } from "./wheel";

afterEach(() => {
  document.body.innerHTML = "";
});

describe("the mouse wheel over a focused number field", () => {
  it("lets go of the field, so the page scrolls and the value stays as typed", () => {
    const stop = guardNumberWheel(document);
    document.body.innerHTML = '<input type="number" value="7" /><input type="text" value="x" />';
    const [num, text] = [...document.querySelectorAll("input")] as HTMLInputElement[];
    num!.focus();
    num!.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: 100 }));
    expect(document.activeElement).not.toBe(num);
    expect(num!.value).toBe("7");
    // Any other field keeps its focus.
    text!.focus();
    text!.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: 100 }));
    expect(document.activeElement).toBe(text);
    stop();
  });
});
