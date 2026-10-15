import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { KeyAnswer } from "@/lib/setup-client";
import { KeyStep } from "./KeyStep";

const LICENCE = { licenseType: "subscription" as const, paidUntil: "2026-11-15", trialEndsAt: null };
const setup = (answer: KeyAnswer) => {
  const onActivate = vi.fn(async () => answer);
  const onApproved = vi.fn();
  render(<KeyStep onActivate={onActivate} onApproved={onApproved} />);
  return { onActivate, onApproved, field: screen.getByLabelText("Product key") };
};

describe("the product key step (spec 2026-10-15 §1.1)", () => {
  it("groups the key as it's typed, counts the groups left, and waits for all five", async () => {
    const { field } = setup({ ok: true, token: "t", licence: LICENCE });
    expect(screen.getByText("Five groups of four. Dashes and spaces don’t matter.")).toBeInTheDocument();
    await userEvent.type(field, "7k2p q9xd");
    expect(field).toHaveValue("LUME-7K2P-Q9XD");
    expect(screen.getByText("3 more groups to go")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
    await userEvent.type(field, "4mrth8vc7q2k");
    expect(field).toHaveValue("LUME-7K2P-Q9XD-4MRT-H8VC-7Q2K");
    expect(screen.getByText("Looks complete")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Continue" })).toBeEnabled();
  });

  it("typing the LUME prefix by hand, letter by letter, isn't read as key characters", async () => {
    const { field } = setup({ ok: true, token: "t", licence: LICENCE });
    await userEvent.type(field, "LUM");
    expect(field).toHaveValue("LUM");
    expect(screen.getByText("Five groups of four. Dashes and spaces don’t matter.")).toBeInTheDocument();
    await userEvent.type(field, "E-7K");
    expect(field).toHaveValue("LUME-7K");
  });

  it("an approved key hands its token and licence on", async () => {
    const { field, onActivate, onApproved } = setup({ ok: true, token: "the-token", licence: LICENCE });
    await userEvent.type(field, "LUME-7K2P-Q9XD-4MRT-H8VC-7Q2K");
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(onActivate).toHaveBeenCalledWith("LUME-7K2P-Q9XD-4MRT-H8VC-7Q2K");
    expect(onApproved).toHaveBeenCalledWith("the-token", LICENCE);
  });

  it.each([
    ["not_recognised", "LUME doesn’t recognise that key. Check it against the message you were sent."],
    ["in_use", "This key is already active on another LUME. Ask whoever gave it to you to release it."],
    [
      "decommissioned",
      "This key has been decommissioned and works nowhere. Use the newest key you were sent.",
    ],
    ["paused", "This key’s licence is paused."],
    ["too_many", "Too many tries. Try again in an hour."],
    [
      "unreachable",
      "LUME couldn’t reach the licence server. Check this server’s internet connection, then try again.",
    ],
  ] as const)("a key refused as %s says so, and nothing goes on", async (reason, words) => {
    const { field, onApproved } = setup({ ok: false, reason });
    await userEvent.type(field, "LUME-7K2P-Q9XD-4MRT-H8VC-7Q2K");
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(words);
    expect(onApproved).not.toHaveBeenCalled();
    if (reason === "unreachable") expect(screen.getByRole("button", { name: "Try again" })).toBeEnabled();
  });

  it("Use another key empties the field after a refusal", async () => {
    const { field } = setup({ ok: false, reason: "not_recognised" });
    await userEvent.type(field, "LUME-7K2P-Q9XD-4MRT-H8VC-7Q2K");
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    await userEvent.click(await screen.findByRole("button", { name: "Use another key" }));
    expect(field).toHaveValue("");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
