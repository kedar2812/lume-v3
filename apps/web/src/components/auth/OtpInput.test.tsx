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

  it("with autoFocus, the first box is ready to type into as it appears: no click first (owner 2026-11-02)", async () => {
    const onComplete = vi.fn();
    render(<OtpInput autoFocus onComplete={onComplete} />);
    expect(document.activeElement).toBe(boxes()[0]);
    await userEvent.keyboard("123456");
    expect(onComplete).toHaveBeenCalledWith("123456");
  });

  it("without it, nothing takes focus (a sheet whose password comes first)", () => {
    render(<OtpInput onComplete={() => undefined} />);
    expect(document.activeElement).toBe(document.body);
  });

  it("back from busy (a wrong code checked), focus returns to the first empty box", () => {
    const { rerender } = render(<OtpInput autoFocus disabled onComplete={() => undefined} />);
    rerender(<OtpInput autoFocus onComplete={() => undefined} />);
    expect(document.activeElement).toBe(boxes()[0]);
  });

  it("a keyboard that only sends input (Android's), and a code filled into one box (iPhone's autofill), both count", () => {
    const onComplete = vi.fn();
    render(<OtpInput onComplete={onComplete} />);
    fireEvent.change(boxes()[0]!, { target: { value: "4" } });
    expect((boxes()[0] as HTMLInputElement).value).toBe("4");
    expect(document.activeElement).toBe(boxes()[1]);
    fireEvent.change(boxes()[0]!, { target: { value: "987654" } });
    expect(onComplete).toHaveBeenCalledWith("987654");
  });
});
