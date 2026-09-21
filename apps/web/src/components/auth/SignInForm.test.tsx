import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SignInForm } from "./SignInForm";

const fill = async () => {
  await userEvent.type(screen.getByLabelText("Email"), "t@nupuur.com");
  await userEvent.type(screen.getByLabelText("Password"), "correct horse");
  await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
};

describe("SignInForm", () => {
  it("shows the brand: LUME above the client name", () => {
    render(
      <SignInForm businessName="Nupuur Coaching" onSignIn={vi.fn()} onVerify={vi.fn()} onSuccess={vi.fn()} />,
    );
    expect(screen.getByRole("heading", { name: "LUME" })).toBeInTheDocument();
    expect(screen.getByText("Nupuur Coaching")).toBeInTheDocument();
  });

  it("gives one generic message for bad credentials (no user enumeration)", async () => {
    render(
      <SignInForm
        businessName="X"
        onSignIn={async () => ({ status: "invalid" })}
        onVerify={vi.fn()}
        onSuccess={vi.fn()}
      />,
    );
    await fill();
    expect(await screen.findByRole("alert")).toHaveTextContent("That email and password don’t match.");
    expect(screen.getByLabelText("Password")).toHaveAttribute("aria-invalid", "true");
  });

  it("moves to the two-step code and finishes", async () => {
    const onSuccess = vi.fn();
    render(
      <SignInForm
        businessName="X"
        onSignIn={async () => ({ status: "otp_required" })}
        onVerify={async () => "ok"}
        onSuccess={onSuccess}
      />,
    );
    await fill();
    const first = await screen.findByLabelText("Digit 1 of 6");
    first.focus();
    await userEvent.keyboard("123456");
    await vi.waitFor(() => expect(onSuccess).toHaveBeenCalled());
  });

  it("explains when the server can't be reached", async () => {
    render(
      <SignInForm
        businessName="X"
        onSignIn={async () => ({ status: "unavailable" })}
        onVerify={vi.fn()}
        onSuccess={vi.fn()}
      />,
    );
    await fill();
    expect(await screen.findByRole("alert")).toHaveTextContent("can’t reach the server");
  });
});
