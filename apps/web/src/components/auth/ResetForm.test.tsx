import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ResetForm } from "./ResetForm";

describe("ResetForm", () => {
  it("explains a refused password in plain words and keeps the person on the page", async () => {
    const onReset = vi.fn(async () => ({ status: "weak" as const, problems: ["breached", "too_short"] }));
    render(<ResetForm businessName="Nupuur Coaching" onReset={onReset} onDone={() => {}} />);
    await userEvent.type(screen.getByLabelText("New password"), "password1");
    await userEvent.click(screen.getByRole("button", { name: "Save password" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/known data breach/i);
    expect(alert).toHaveTextContent(/at least 12/i);
    expect(screen.getByLabelText("New password")).toBeEnabled();
  });

  it("says plainly when the link has expired, and offers a new one", async () => {
    render(
      <ResetForm
        businessName="Nupuur Coaching"
        onReset={async () => ({ status: "expired" })}
        onDone={() => {}}
      />,
    );
    await userEvent.type(screen.getByLabelText("New password"), "a long new passphrase");
    await userEvent.click(screen.getByRole("button", { name: "Save password" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/link has expired/i);
    expect(screen.getByRole("link", { name: /ask for a new link/i })).toHaveAttribute("href", "/forgot");
  });
});
