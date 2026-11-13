import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/lib/api";
import type { LicenceForPerson } from "@/lib/licence/client";
import { fakeSession } from "@/server/session";
import { LicenceProvider } from "./LicenceProvider";
import { PlanCard } from "./PlanCard";

vi.mock("@/lib/api", () => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() },
}));

const licence = (over: Partial<LicenceForPerson> = {}) =>
  ({
    state: "active",
    reason: "paid",
    graceEndsAt: null,
    licenseType: "subscription",
    paidUntil: "2027-03-12",
    trialEndsAt: null,
    notice: null,
    announcements: [],
    plan: null,
    checkedAt: null,
    dev: false,
    instanceId: "LUME-7F3K-Q9M2",
    nextCheckAt: null,
    showNotice: false,
    canCheck: false,
    lastError: null,
    key: { masked: null, source: null, canChange: false },
    feedback: false,
    tier: null,
    ...over,
  }) satisfies LicenceForPerson;
const ADMIN = [{ key: "settings.manage" as const, scope: null }];
const card = (l: LicenceForPerson, admin = true) =>
  render(
    <LicenceProvider session={fakeSession({ permissions: admin ? ADMIN : [], licence: l })}>
      <PlanCard />
    </LicenceProvider>,
  );

beforeEach(() => vi.mocked(api.post).mockReset());

describe("Your plan (Plans and pricing, November 2026)", () => {
  it("says the tier, what's in it, and what the next one adds, with a way for an admin to ask", async () => {
    vi.mocked(api.post).mockResolvedValue({ ok: true, status: 200, data: { asked: true } });
    card(licence({ tier: "pro" }));
    const plan = screen.getByRole("region", { name: "Your plan" });
    expect(within(plan).getByText("Pro")).toBeInTheDocument();
    const inIt = within(plan).getByRole("list", { name: "In your plan" });
    expect(inIt).toHaveTextContent("Autopilot first messages and follow-ups");
    expect(inIt).toHaveTextContent("Unlimited seats");
    expect(inIt).not.toHaveTextContent("Autopilot replies");
    const next = within(plan).getByRole("list", { name: "Max adds" });
    expect(next).toHaveTextContent("Autopilot replies to your leads");
    expect(next).toHaveTextContent("“Ask me” approval for replies");
    await userEvent.click(within(plan).getByRole("button", { name: "Ask about Max" }));
    expect(api.post).toHaveBeenCalledWith("/api/v1/plan/ask", { tier: "max" });
    expect(await within(plan).findByText("Asked. LUME will let you know.")).toBeInTheDocument();
    expect(within(plan).queryByRole("button", { name: "Ask about Max" })).toBeNull();
  });

  it("shows only the newest AI leads a month, never two numbers", () => {
    card(licence({ tier: "max" }));
    const inIt = screen.getByRole("list", { name: "In your plan" });
    expect(inIt).toHaveTextContent("3,000 AI leads a month");
    expect(inIt).not.toHaveTextContent("1,000");
  });

  it("someone who doesn't manage settings sees the plan, and who can ask", () => {
    card(licence({ tier: "base" }), false);
    expect(screen.queryByRole("button", { name: /Ask about/ })).toBeNull();
    expect(screen.getByText("An admin can ask LUME about Pro.")).toBeInTheDocument();
  });

  it("Enterprise has nothing above it", () => {
    card(licence({ tier: "enterprise" }));
    expect(screen.getByText("Everything LUME offers is in your plan.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Ask about/ })).toBeNull();
  });

  it("a refusal is said, and the button stays to try again", async () => {
    vi.mocked(api.post).mockResolvedValue({
      ok: false,
      status: 502,
      code: "UNREACHABLE",
      message: "LUME couldn't reach its licence server just now. Try again in a minute.",
    } as never);
    card(licence({ tier: "max" }));
    await userEvent.click(screen.getByRole("button", { name: "Ask about Enterprise" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("couldn't reach its licence server");
    expect(screen.getByRole("button", { name: "Ask about Enterprise" })).toBeEnabled();
  });

  it("no tier: there is no plan card at all", () => {
    const { container } = card(licence());
    expect(container).toBeEmptyDOMElement();
  });
});
