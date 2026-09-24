import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { AcceptInvite } from "./AcceptInvite";

const invite = { email: "riya@nupuur.com", name: "Riya", businessName: "Nupuur Coaching" };

describe("AcceptInvite", () => {
  it("shows who the invite is for, and the address cannot be changed", () => {
    render(<AcceptInvite invite={invite} onAccept={async () => ({ status: "ok" })} onDone={() => {}} />);
    expect(screen.getByText(/Nupuur Coaching/)).toBeInTheDocument();
    expect(screen.getByLabelText("Email")).toHaveValue("riya@nupuur.com");
    expect(screen.getByLabelText("Email")).toBeDisabled();
  });

  it("explains a refused password and lets the person try again", async () => {
    const onAccept = vi.fn(async () => ({ status: "weak" as const, problems: ["breached"] }));
    render(<AcceptInvite invite={invite} onAccept={onAccept} onDone={() => {}} />);
    await userEvent.type(screen.getByLabelText("Choose a password"), "password123456");
    await userEvent.click(screen.getByRole("button", { name: "Join LUME" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/known data breach/i);
    expect(screen.getByLabelText("Choose a password")).toBeEnabled();
  });

  it("says plainly when the invite is no longer usable", async () => {
    render(<AcceptInvite invite={invite} onAccept={async () => ({ status: "gone" })} onDone={() => {}} />);
    await userEvent.type(screen.getByLabelText("Choose a password"), "a long new passphrase");
    await userEvent.click(screen.getByRole("button", { name: "Join LUME" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/already been used or has expired/i);
  });

  it("hands over to onboarding once accepted", async () => {
    const onDone = vi.fn();
    render(<AcceptInvite invite={invite} onAccept={async () => ({ status: "ok" })} onDone={onDone} />);
    await userEvent.type(screen.getByLabelText("Choose a password"), "a long new passphrase");
    await userEvent.click(screen.getByRole("button", { name: "Join LUME" }));
    expect(onDone).toHaveBeenCalledTimes(1);
  });
});
