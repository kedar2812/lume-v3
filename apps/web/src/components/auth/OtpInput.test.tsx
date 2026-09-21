import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { OtpInput } from "./OtpInput";

const boxes = () => screen.getAllByRole("textbox");

describe("OtpInput", () => {
  it("advances as digits are typed and completes once", async () => {
    const onComplete = vi.fn();
    render(<OtpInput onComplete={onComplete} />);
    boxes()[0]!.focus();
    await userEvent.keyboard("12a3456");
    expect(
      boxes()
        .map((b) => (b as HTMLInputElement).value)
        .join(""),
    ).toBe("123456");
    expect(onComplete).toHaveBeenCalledOnce();
    expect(onComplete).toHaveBeenCalledWith("123456");
  });

  it("goes back on Backspace from an empty box", async () => {
    render(<OtpInput onComplete={() => undefined} />);
    boxes()[0]!.focus();
    await userEvent.keyboard("12{Backspace}{Backspace}");
    expect(document.activeElement).toBe(boxes()[0]);
  });

  it("accepts a pasted code", () => {
    const onComplete = vi.fn();
    render(<OtpInput onComplete={onComplete} />);
    fireEvent.paste(boxes()[0]!, { clipboardData: { getData: () => " 654 321 " } });
    expect(onComplete).toHaveBeenCalledWith("654321");
  });

  it("labels every box", () => {
    render(<OtpInput onComplete={() => undefined} />);
    expect(screen.getByLabelText("Digit 1 of 6")).toBeInTheDocument();
  });
});
