import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { PasswordInput } from "./PasswordInput";

const field = () =>
  render(
    <>
      <label htmlFor="pw">Password</label>
      <PasswordInput id="pw" name="password" autoComplete="current-password" />
      <button type="button">Elsewhere</button>
    </>,
  );

describe("PasswordInput", () => {
  it("shows and hides what was typed with the eye, keeping the typing in the field", async () => {
    field();
    const input = screen.getByLabelText("Password");
    await userEvent.type(input, "correct horse");
    expect(input).toHaveAttribute("type", "password");
    await userEvent.click(screen.getByRole("button", { name: "Show password" }));
    expect(input).toHaveAttribute("type", "text");
    expect(screen.getByRole("button", { name: "Hide password" })).toHaveAttribute("aria-pressed", "true");
    expect(input).toHaveFocus(); // the eye never takes the cursor away
    await userEvent.keyboard(" battery");
    expect(input).toHaveValue("correct horse battery");
    await userEvent.click(screen.getByRole("button", { name: "Hide password" }));
    expect(input).toHaveAttribute("type", "password");
  });

  it("says when Caps Lock is on while typing, and stops saying it when it's off or the field is left", async () => {
    field();
    const input = screen.getByLabelText("Password");
    // Each key carries the keyboard's Caps Lock state, as a real browser's events do.
    const key = (k: string, capsOn: boolean) =>
      fireEvent.keyDown(input, { key: k, modifierCapsLock: capsOn });
    await userEvent.click(input);
    expect(screen.queryByText("Caps Lock is on")).not.toBeInTheDocument();
    key("A", true);
    expect(screen.getByRole("status")).toHaveTextContent("Caps Lock is on");
    expect(input).toHaveAccessibleDescription("Caps Lock is on");
    key("b", false);
    expect(screen.queryByText("Caps Lock is on")).not.toBeInTheDocument();
    key("C", true);
    expect(screen.getByText("Caps Lock is on")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Elsewhere" }));
    expect(screen.queryByText("Caps Lock is on")).not.toBeInTheDocument();
  });

  it("keeps a description the page gave the field", async () => {
    render(
      <>
        <label htmlFor="pw2">Password</label>
        <PasswordInput id="pw2" aria-describedby="pw2-hint" />
        <p id="pw2-hint">At least 12 characters.</p>
      </>,
    );
    const input = screen.getByLabelText("Password");
    expect(input).toHaveAccessibleDescription("At least 12 characters.");
    await userEvent.click(input);
    fireEvent.keyDown(input, { key: "A", modifierCapsLock: true });
    expect(input).toHaveAccessibleDescription("At least 12 characters. Caps Lock is on");
  });
});
