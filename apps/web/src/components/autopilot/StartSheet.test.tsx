import { AUTOPILOT_ACTIONS, AUTOPILOT_PRESETS, type AutopilotAction } from "@lume/core/shared";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { autopilotClient } from "@/lib/autopilot/client";
import type { AutopilotSetup, Available, Estimate } from "@/lib/autopilot/types";
import { StartSheet } from "./StartSheet";

vi.mock("@/lib/autopilot/client", () => ({
  autopilotClient: { setup: vi.fn(), estimate: vi.fn(), start: vi.fn() },
}));
vi.mock("@/lib/usePhone", () => ({ usePhone: () => false }));

const ok = <T,>(data: T) => ({ ok: true as const, status: 200, data });
const refused = (message: string) => ({ ok: false as const, status: 409, code: "X", message });
const okRow: Available = { ok: true };
const setup = (o: Partial<AutopilotSetup> = {}): AutopilotSetup => ({
  ready: { ok: true },
  goals: [
    { kind: "stage", stageId: "s2", name: "Site visit booked" },
    { kind: "stage", stageId: "s4", name: "Quote shared" },
  ],
  speakers: [
    { id: "u1", name: "Priya Nair" },
    { id: "u2", name: "Rahul Mehta" },
  ],
  standing: { permissions: AUTOPILOT_PRESETS.balanced, followUpDays: [2, 5], dailyCap: null, speaker: null },
  available: Object.fromEntries(AUTOPILOT_ACTIONS.map((a) => [a, okRow])) as Record<
    AutopilotAction,
    Available
  >,
  hours: { line: "Monday to Saturday, 10 am to 7 pm" },
  number: { display: "+91 90000 00001", tierLimit: 250 },
  canRemember: true,
  ...o,
});
const estimate = (o: Partial<Estimate> = {}): Estimate => ({
  eligible: 2,
  skipped: [],
  firstMessages: 2,
  metaCost: { amount: 43.2, currency: "INR" },
  monthShare: 0.0612,
  ...o,
});
const ids = { leadIds: ["l1", "l2", "l3"] };
const open = (o: { target?: Parameters<typeof StartSheet>[0]["target"]; count?: number } = {}) => {
  const onClose = vi.fn();
  const onStarted = vi.fn();
  render(
    <StartSheet target={o.target ?? ids} count={o.count ?? 3} onClose={onClose} onStarted={onStarted} />,
  );
  return { onClose, onStarted };
};
const start = () => screen.getByRole("button", { name: "Start the run" });

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(autopilotClient.setup).mockResolvedValue(ok(setup()));
  vi.mocked(autopilotClient.estimate).mockResolvedValue(ok(estimate()));
});

/** Starting a run (Autopilot spec 2026-10-19 §1): the sheet, from the island. */
describe("StartSheet", () => {
  it("not ready yet: says what's missing and where to fix it, and nothing else", async () => {
    vi.mocked(autopilotClient.setup).mockResolvedValue(
      ok(
        setup({
          ready: {
            ok: false,
            code: "NO_NUMBER",
            message: "LUME AI works on WhatsApp. Connect a number in Settings → Integrations → WhatsApp.",
            fixHref: "/settings/integrations/whatsapp",
          },
        }),
      ),
    );
    open();
    expect(await screen.findByText(/LUME AI works on WhatsApp/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open WhatsApp settings" })).toHaveAttribute(
      "href",
      "/settings/integrations/whatsapp",
    );
    expect(screen.queryByRole("button", { name: "Start the run" })).toBeNull();
    expect(autopilotClient.estimate).not.toHaveBeenCalled();
  });

  it("opens with the business's own goals, people and hours; says what Start will do in plain numbers", async () => {
    open();
    expect(await screen.findByRole("dialog", { name: "Let LUME AI handle 3 leads" })).toBeInTheDocument();
    expect(await screen.findByRole("radio", { name: "Site visit booked" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(screen.getByRole("combobox", { name: "Speaks as" })).toHaveDisplayValue("You");
    expect(screen.getByText("Monday to Saturday, 10 am to 7 pm")).toBeInTheDocument();
    expect(
      await screen.findByText("2 first messages · about ₹43 to Meta · uses about 6% of this month's LUME AI"),
    ).toBeInTheDocument();
    expect(autopilotClient.estimate).toHaveBeenLastCalledWith({
      leadIds: ["l1", "l2", "l3"],
      goal: { kind: "stage", stageId: "s2" },
      speakerId: null,
      permissions: AUTOPILOT_PRESETS.balanced,
      followUpDays: [2, 5],
      dailyCap: null,
      remember: false,
    });
  });

  it("the skipped are counted, and each reason opens with how many", async () => {
    vi.mocked(autopilotClient.estimate).mockResolvedValue(
      ok(
        estimate({
          eligible: 1,
          firstMessages: 1,
          skipped: [
            { leadId: "l2", why: "No WhatsApp number" },
            { leadId: "l3", why: "No WhatsApp number" },
          ],
        }),
      ),
    );
    open();
    await userEvent.click(await screen.findByRole("button", { name: "2 skipped" }));
    expect(screen.getByRole("list", { name: "Skipped leads" })).toHaveTextContent("No WhatsApp number · 2");
  });

  it("a written goal must be confirmed before Start, and Start says so", async () => {
    open();
    await userEvent.click(await screen.findByRole("radio", { name: "Write your own" }));
    expect(start()).toBeDisabled();
    expect(screen.getByText("Confirm your goal to start the run")).toBeInTheDocument();
    await userEvent.type(
      screen.getByRole("textbox", { name: "Your goal" }),
      "Book a call with each of them this week",
    );
    await userEvent.click(screen.getByRole("button", { name: "Confirm" }));
    expect(start()).toBeEnabled();
  });

  it("none of these leads can be messaged: Start stays off, and says why", async () => {
    vi.mocked(autopilotClient.estimate).mockResolvedValue(
      ok(
        estimate({
          eligible: 0,
          firstMessages: 0,
          skipped: [{ leadId: "l1", why: "Asked not to be messaged" }],
        }),
      ),
    );
    open({ target: { leadIds: ["l1"] }, count: 1 });
    expect(await screen.findByText("None of these leads can be messaged")).toBeInTheDocument();
    expect(start()).toBeDisabled();
  });

  it("Start sends the choices as made, for all that match a filter, and hands the run over", async () => {
    vi.mocked(autopilotClient.start).mockResolvedValue(
      ok({ run: { id: "run1" } as never, skipped: [], remembered: true, leads: 40 }),
    );
    const selection = { filters: { tagId: "t1" }, except: [], expected: 40 };
    const { onStarted } = open({ target: { selection }, count: 40 });
    await userEvent.click(await screen.findByRole("radio", { name: "Get a reply" }));
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Speaks as" }), "Rahul Mehta");
    await userEvent.click(screen.getByRole("button", { name: /^Hands-off/ }));
    await userEvent.click(screen.getByRole("switch", { name: "Use these every time" }));
    await userEvent.click(start());
    expect(autopilotClient.start).toHaveBeenCalledWith({
      selection,
      goal: { kind: "reply" },
      speakerId: "u2",
      permissions: AUTOPILOT_PRESETS.hands_off,
      followUpDays: [2, 5],
      dailyCap: null,
      remember: true,
    });
    await waitFor(() =>
      expect(onStarted).toHaveBeenCalledWith(expect.objectContaining({ run: { id: "run1" } })),
    );
  });

  it("a refusal is said in its own words, and the sheet stays", async () => {
    vi.mocked(autopilotClient.start).mockResolvedValue(
      refused(
        "WhatsApp rated +91 90000 00001 yellow. LUME AI waits until it recovers, to protect the number.",
      ),
    );
    const { onStarted } = open();
    await userEvent.click(await screen.findByRole("button", { name: "Start the run" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("WhatsApp rated +91 90000 00001 yellow.");
    expect(onStarted).not.toHaveBeenCalled();
    expect(start()).toBeEnabled();
  });

  it("Use these every time is only for admins; a daily cap can be set here", async () => {
    vi.mocked(autopilotClient.setup).mockResolvedValue(ok(setup({ canRemember: false })));
    open();
    await screen.findByRole("radio", { name: "Site visit booked" });
    expect(screen.queryByRole("switch", { name: "Use these every time" })).toBeNull();
    expect(screen.getByText("Up to 250 a day, your number's WhatsApp limit")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("switch", { name: "Set a daily cap" }));
    const cap = screen.getByRole("spinbutton", { name: "Messages a day, at most" });
    await userEvent.clear(cap);
    await userEvent.type(cap, "25");
    await waitFor(() =>
      expect(autopilotClient.estimate).toHaveBeenLastCalledWith(expect.objectContaining({ dailyCap: 25 })),
    );
  });

  it("more than a run takes: says so before anything else, and asks nothing", async () => {
    open({ target: { selection: { filters: { q: "a" }, except: [], expected: 501 } }, count: 501 });
    expect(
      await screen.findByText("A run takes up to 500 leads. Narrow the filter, then try again."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Start the run" })).toBeNull();
    expect(autopilotClient.setup).not.toHaveBeenCalled();
  });

  it("a burst of changes asks for one estimate, not one each", async () => {
    open();
    await screen.findByText(/first messages/);
    const before = vi.mocked(autopilotClient.estimate).mock.calls.length;
    const rows = screen.getByRole("group", { name: "Careful" });
    for (const name of ["Ask me", "Never", "Go ahead"])
      await userEvent.click(
        within(within(rows).getByRole("radiogroup", { name: "Mark a lead lost" })).getByRole("radio", {
          name,
        }),
      );
    await waitFor(() => expect(vi.mocked(autopilotClient.estimate).mock.calls.length).toBe(before + 1));
  });
});
