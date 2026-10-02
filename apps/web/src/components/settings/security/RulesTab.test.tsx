import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mergeAnomaly } from "@lume/core/shared";
import { api } from "@/lib/api";
import type { SecuritySettings } from "@/lib/settings/security";
import { RulesTab } from "./RulesTab";

vi.mock("@/lib/api", () => ({ api: { put: vi.fn() } }));
const ok = <T,>(data: T) => ({ ok: true as const, status: 200, data });
const fail = { ok: false as const, status: 500, code: "INTERNAL_ERROR", message: "LUME couldn’t save that." };
const viewer = { name: "Sam Okafor", email: "sam@example.test", today: "2026-10-01" };
const initial: SecuritySettings = { anomaly: mergeAnomaly({}), watermark: "masked_roles" };
const echo = () => vi.mocked(api.put).mockImplementation(async (_url, body) => ok(body as SecuritySettings));

beforeEach(() => vi.clearAllMocks());

const row = (name: RegExp) => screen.getByRole("group", { name });

describe("Settings → Security → Rules (6A Task 6)", () => {
  it("lists the three rules, each with its sentence and what LUME does", () => {
    render(<RulesTab initial={initial} viewer={viewer} />);
    const reveals = row(/More than 30 contacts opened in an hour/);
    expect(
      within(reveals).getByText("LUME tells you, ends their sessions and pauses sign-in"),
    ).toBeInTheDocument();
    expect(
      within(row(/More than 3 WhatsApp send-queue runs in a day/)).getByText("LUME tells you"),
    ).toBeInTheDocument();
    expect(screen.getByText(/Never to you\./)).toBeInTheDocument();
  });

  it("a switch turns a rule off at once, saving the whole set", async () => {
    echo();
    render(<RulesTab initial={initial} viewer={viewer} />);
    const reveals = row(/More than 30 contacts opened/);
    const sw = within(reveals).getByRole("switch");
    expect(sw).toHaveAttribute("aria-checked", "true");
    await userEvent.click(sw);
    expect(sw).toHaveAttribute("aria-checked", "false");
    expect(within(reveals).getByText("Off")).toBeInTheDocument();
    expect(api.put).toHaveBeenCalledWith("/api/v1/security/settings", {
      anomaly: { ...initial.anomaly, reveals: { action: "off", threshold: 30 } },
      watermark: "masked_roles",
    });
  });

  it("turned back on, a rule keeps the action it had", async () => {
    echo();
    render(<RulesTab initial={initial} viewer={viewer} />);
    const sw = within(row(/contacts opened/)).getByRole("switch");
    await userEvent.click(sw);
    await userEvent.click(sw);
    expect(vi.mocked(api.put).mock.calls.at(-1)![1]).toMatchObject({
      anomaly: { reveals: { action: "suspend", threshold: 30 } },
    });
  });

  it("the stepper moves by the rule's step and never below its floor", async () => {
    echo();
    render(<RulesTab initial={initial} viewer={viewer} />);
    const reveals = row(/contacts opened/);
    await userEvent.click(within(reveals).getByRole("button", { name: "Edit" }));
    const higher = within(reveals).getByRole("button", { name: "Higher limit" });
    const lower = within(reveals).getByRole("button", { name: "Lower limit" });
    await userEvent.click(higher);
    expect(row(/More than 35 contacts opened in an hour/)).toBe(reveals);
    for (let i = 0; i < 10; i++) await userEvent.click(lower);
    expect(row(/More than 5 contacts opened in an hour/)).toBe(reveals);
    expect(lower).toBeDisabled();
  });

  it("the send-queue rule only ever tells you: no pause to choose", async () => {
    render(<RulesTab initial={initial} viewer={viewer} />);
    const queue = row(/send-queue runs/);
    await userEvent.click(within(queue).getByRole("button", { name: "Edit" }));
    expect(within(queue).getByRole("radio", { name: /Tells you/ })).toBeChecked();
    expect(within(queue).queryByRole("radio", { name: /pauses their access/ })).not.toBeInTheDocument();
  });

  it("choosing what LUME does saves it", async () => {
    echo();
    render(<RulesTab initial={initial} viewer={viewer} />);
    const views = row(/different leads opened/);
    await userEvent.click(within(views).getByRole("button", { name: "Edit" }));
    await userEvent.click(within(views).getByRole("radio", { name: /^Tells you An alert/ }));
    expect(within(views).getByText("LUME tells you")).toBeInTheDocument();
    expect(vi.mocked(api.put).mock.calls.at(-1)![1]).toMatchObject({
      anomaly: { leadsOpened: { action: "alert", threshold: 200 } },
    });
  });

  it("a save that fails puts the rule back and says so", async () => {
    vi.mocked(api.put).mockResolvedValue(fail);
    render(<RulesTab initial={initial} viewer={viewer} />);
    const sw = within(row(/contacts opened/)).getByRole("switch");
    await userEvent.click(sw);
    expect(await screen.findByRole("alert")).toHaveTextContent("LUME couldn’t save that.");
    expect(sw).toHaveAttribute("aria-checked", "true");
  });

  it("the watermark: three choices, and a live preview with the viewer's own name", async () => {
    echo();
    render(<RulesTab initial={initial} viewer={viewer} />);
    const preview = screen.getByTestId("watermark-preview");
    expect(preview.querySelector("[data-watermark]")).toHaveAttribute(
      "data-watermark",
      "Sam Okafor · sam@example.test · Oct 1",
    );
    expect(screen.getByRole("radio", { name: /People who can’t see every contact/ })).toBeChecked();
    await userEvent.click(screen.getByRole("radio", { name: /^Nobody/ }));
    expect(preview).toHaveAttribute("data-mode", "off");
    expect(vi.mocked(api.put).mock.calls.at(-1)![1]).toMatchObject({ watermark: "off" });
  });

  it("every control has a name, and Tab reaches it", async () => {
    render(<RulesTab initial={initial} viewer={viewer} />);
    for (const sw of screen.getAllByRole("switch")) expect(sw).toHaveAccessibleName();
    await userEvent.tab();
    expect(document.activeElement).not.toBe(document.body);
  });
});
