import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { SetupInput, SetupResult } from "@/lib/setup-client";
import { SetupWizard } from "./SetupWizard";

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
  // One component per tag, made once: a fresh type on every render would remount controlled inputs.
  const made = new Map<string, unknown>();
  const motion = new Proxy(
    {},
    {
      get: (_t, tag: string) => {
        if (!made.has(tag))
          made.set(
            tag,
            forwardRef((p: Record<string, unknown>, ref) => createElement(tag, { ...strip(p), ref })),
          );
        return made.get(tag);
      },
    },
  );
  return {
    motion,
    AnimatePresence: ({ children }: { children: unknown }) => children,
    useReducedMotion: () => true,
  };
});

const secret = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";
type StartTotp = (token: string) => Promise<{ secret: string; otpauthUri: string } | { error: string }>;
type Complete = (input: SetupInput) => Promise<SetupResult>;
const codes = Array.from({ length: 10 }, (_, i) => `CODE${i}-XXXXX`);
const props = (complete: Complete = async () => ({ status: "ok", recoveryCodes: codes })) => ({
  onStartTotp: vi.fn<StartTotp>(async () => ({
    secret,
    otpauthUri: `otpauth://totp/LUME:owner?secret=${secret}`,
  })),
  onComplete: vi.fn<Complete>(complete),
  onDone: vi.fn(),
});

const typeCode = async (code: string) => {
  const first = await screen.findByLabelText("Digit 1 of 6");
  first.focus();
  await userEvent.keyboard(code);
};

async function fillToTwoFactor(p: ReturnType<typeof props>) {
  render(<SetupWizard {...p} />);
  await userEvent.type(screen.getByLabelText("Setup token"), "token-from-the-server-logs");
  await userEvent.click(screen.getByRole("button", { name: "Continue" }));
  await userEvent.type(await screen.findByLabelText("Business name"), "Nupuur Coaching");
  await userEvent.click(screen.getByRole("button", { name: "Continue" }));
  await userEvent.type(await screen.findByLabelText("Your name"), "Nupuur Patil");
  await userEvent.type(screen.getByLabelText("Email"), "nupuur@nupuur.com");
  await userEvent.type(screen.getByLabelText("Password"), "a long and lovely passphrase");
  await userEvent.click(screen.getByRole("button", { name: "Continue" }));
}

describe("SetupWizard", () => {
  it("walks token → business → owner → two-step → recovery codes", async () => {
    const p = props();
    await fillToTwoFactor(p);
    expect(p.onStartTotp).toHaveBeenCalledWith("token-from-the-server-logs");
    // The key is shown for anyone who can't scan the QR code.
    expect(await screen.findByText(new RegExp(secret.slice(0, 8)))).toBeInTheDocument();
    await typeCode("123456");
    await userEvent.click(screen.getByRole("button", { name: "Finish setup" }));

    expect(await screen.findByText("CODE0-XXXXX")).toBeInTheDocument();
    expect(screen.getByText(/save these somewhere safe/i)).toBeInTheDocument();
    expect(p.onDone).not.toHaveBeenCalled(); // not until they confirm they saved them
    await userEvent.click(screen.getByRole("checkbox", { name: /saved/i }));
    await userEvent.click(screen.getByRole("button", { name: /open lume/i }));
    expect(p.onDone).toHaveBeenCalled();
    const sent = p.onComplete.mock.calls[0]![0];
    expect(sent).toMatchObject({
      token: "token-from-the-server-logs",
      preset: "coaching",
      business: { name: "Nupuur Coaching", currency: "AED", defaultCountry: "AE" },
      owner: { name: "Nupuur Patil", email: "nupuur@nupuur.com" },
      totp: { secret, code: "123456" },
    });
    expect(sent.business.timezone).toMatch(/^[A-Za-z_]+(\/[A-Za-z_+-]+)*$/);
  });

  it("cannot be finished before the codes are saved", async () => {
    const p = props();
    await fillToTwoFactor(p);
    await typeCode("123456");
    await userEvent.click(screen.getByRole("button", { name: "Finish setup" }));
    expect(await screen.findByRole("button", { name: /open lume/i })).toBeDisabled();
  });

  it("keeps the person on the token step when the token is refused", async () => {
    const p = {
      ...props(),
      onStartTotp: vi.fn<StartTotp>(async () => ({ error: "That setup token isn’t valid" })),
    };
    render(<SetupWizard {...p} />);
    await userEvent.type(screen.getByLabelText("Setup token"), "wrong");
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/isn’t valid/);
    expect(screen.getByLabelText("Setup token")).toBeInTheDocument();
  });

  it("explains a refused code without losing anything typed", async () => {
    const p = props(async () => ({ status: "code" }));
    await fillToTwoFactor(p);
    await typeCode("000000");
    await userEvent.click(screen.getByRole("button", { name: "Finish setup" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/didn’t work/i);
    expect(await screen.findByLabelText("Digit 1 of 6")).toBeInTheDocument();
  });

  it("explains a refused password and returns to the owner step", async () => {
    const p = props(async () => ({ status: "weak", problems: ["breached"] }));
    await fillToTwoFactor(p);
    await typeCode("123456");
    await userEvent.click(screen.getByRole("button", { name: "Finish setup" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/known data breach/i);
    expect(screen.getByLabelText("Password")).toHaveValue("a long and lovely passphrase");
  });

  it("sends the second preset when it is chosen, and lets someone go back to change it", async () => {
    const p = props();
    render(<SetupWizard {...p} />);
    await userEvent.type(screen.getByLabelText("Setup token"), "tok");
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    await userEvent.type(await screen.findByLabelText("Business name"), "Acme Sales");
    await userEvent.click(screen.getByRole("radio", { name: /general sales/i }));
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    await userEvent.click(await screen.findByRole("button", { name: "Back" }));
    expect(await screen.findByLabelText("Business name")).toHaveValue("Acme Sales");
    expect(screen.getByRole("radio", { name: /general sales/i })).toBeChecked();
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    await userEvent.type(await screen.findByLabelText("Your name"), "Ravi");
    await userEvent.type(screen.getByLabelText("Email"), "ravi@acme.test");
    await userEvent.type(screen.getByLabelText("Password"), "another long passphrase");
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    await typeCode("123456");
    await userEvent.click(screen.getByRole("button", { name: "Finish setup" }));
    await screen.findByText("CODE0-XXXXX");
    expect(p.onComplete.mock.calls[0]![0]).toMatchObject({ preset: "general" });
  });
});
