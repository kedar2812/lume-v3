import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SignInForm } from "./SignInForm";

// jsdom runs no animations, so AnimatePresence would wait forever for an exit before mounting the next step.
vi.mock("motion/react", async () => {
  const { createElement, forwardRef } = await import("react");
  const strip = ({ initial, animate, exit, transition, layout, ...rest }: Record<string, unknown>) => (
    void initial,
    void animate,
    void exit,
    void transition,
    void layout,
    rest
  );
  const motion = new Proxy(
    {},
    {
      get: (_t, tag: string) =>
        forwardRef((p: Record<string, unknown>, ref) => createElement(tag, { ...strip(p), ref })),
    },
  );
  return {
    motion,
    AnimatePresence: ({ children }: { children: unknown }) => children,
    useReducedMotion: () => true,
  };
});

const fill = async () => {
  await userEvent.type(screen.getByLabelText("Email"), "t@nupuur.com");
  await userEvent.type(screen.getByLabelText("Password"), "correct horse");
  await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
};

describe("SignInForm", () => {
  it("shows the brand: LUME above the client name", () => {
    render(
      <SignInForm
        businessName="Nupuur Coaching"
        onSignIn={vi.fn()}
        onVerify={vi.fn()}
        onVerifyRecovery={vi.fn()}
        onSuccess={vi.fn()}
      />,
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
        onVerifyRecovery={vi.fn()}
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
        onVerifyRecovery={vi.fn()}
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
        onVerifyRecovery={vi.fn()}
        onSuccess={vi.fn()}
      />,
    );
    await fill();
    expect(await screen.findByRole("alert")).toHaveTextContent("can’t reach the server");
  });

  it("offers a recovery code after the app code, and verifies it", async () => {
    const onVerifyRecovery = vi.fn(async () => "ok" as const);
    render(
      <SignInForm
        businessName="Nupuur Coaching"
        onSignIn={async () => ({ status: "otp_required" })}
        onVerify={async () => "invalid"}
        onVerifyRecovery={onVerifyRecovery}
        onSuccess={() => {}}
      />,
    );
    await userEvent.type(screen.getByLabelText("Email"), "a@b.c");
    await userEvent.type(screen.getByLabelText("Password"), "pw");
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await userEvent.click(await screen.findByRole("button", { name: /recovery code/i }));
    await userEvent.type(screen.getByLabelText("Recovery code"), "AAAAA-BBBBB");
    await userEvent.click(screen.getByRole("button", { name: "Use code" }));
    expect(onVerifyRecovery).toHaveBeenCalledWith("AAAAA-BBBBB");
  });

  it("says how long a lockout lasts", async () => {
    render(
      <SignInForm
        businessName="Nupuur Coaching"
        onSignIn={async () => ({ status: "locked", retryAfterSec: 900 })}
        onVerify={async () => "ok"}
        onVerifyRecovery={async () => "ok"}
        onSuccess={() => {}}
      />,
    );
    await userEvent.type(screen.getByLabelText("Email"), "a@b.c");
    await userEvent.type(screen.getByLabelText("Password"), "pw");
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/15 minutes/);
  });
});
