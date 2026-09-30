// @vitest-environment jsdom
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/lib/client";
import { computeAnalytics } from "@/lib/analytics";
import { CANVAS_CLIENTS, CANVAS_DECLINING, CANVAS_LIST_PRICE, CANVAS_NOW, CANVAS_RATES } from "@/lib/fixture";
import { AnalyticsScreen } from "./AnalyticsScreen";
import { Bell } from "./Bell";
import { ClientScreen } from "./ClientScreen";
import { ClientsScreen } from "./ClientsScreen";
import { SignIn } from "./SignIn";
import { ThemeSwitch } from "./Shell";

vi.mock("@/lib/client", () => ({
  CHANGED: "lume-licence:changed",
  api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), del: vi.fn() },
}));
vi.mock("next/link", () => ({
  default: ({ href, children, ...p }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...p}>
      {children}
    </a>
  ),
}));
const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, refresh: vi.fn() }),
  usePathname: () => "/clients",
}));

const ok = <T,>(data: T) => ({ ok: true as const, data });
const RATES = { day: "2026-09-29", ageDays: 0, rates: { INR: 1, AED: 24.07, USD: 88.4, GBP: 118.6 } };

beforeEach(() => {
  vi.mocked(api.get).mockReset();
  vi.mocked(api.post).mockReset();
  vi.mocked(api.del).mockReset();
  vi.mocked(api.patch).mockReset();
  push.mockReset();
  localStorage.clear();
  delete document.documentElement.dataset.theme;
});

const ALERTS = [
  {
    id: "late:c1",
    fingerprint: "2026-09-26",
    tone: "red",
    title: "Harbour Clinic's payment is 3 days late",
    body: "₹2,999 was due on 26 Sep.",
    clientId: "c1",
    clientName: "Harbour Clinic",
  },
  {
    id: "trial:c2",
    fingerprint: "2026-10-14",
    tone: "violet",
    title: "Cedar & Co Salon's trial ends in 15 days",
    body: "A good week for a friendly call.",
    clientId: "c2",
    clientName: "Cedar & Co Salon",
  },
];

describe("the bell (spec §4.4)", () => {
  it("counts what needs a look, hides one, hides all, then says All clear", async () => {
    vi.mocked(api.get).mockResolvedValue(ok({ alerts: ALERTS }));
    render(<Bell />);
    const bell = await screen.findByRole("button", { name: "2 things need a look" });
    await userEvent.click(bell);
    const pop = screen.getByRole("dialog", { name: "Needs a look" });
    expect(within(pop).getByText("Harbour Clinic's payment is 3 days late")).toBeInTheDocument();
    expect(within(pop).getByRole("link", { name: "Open Harbour Clinic" })).toHaveAttribute(
      "href",
      "/clients/c1",
    );

    vi.mocked(api.post).mockResolvedValueOnce(ok({ alerts: [ALERTS[1]] }));
    await userEvent.click(
      within(pop).getByRole("button", { name: "Hide: Harbour Clinic's payment is 3 days late" }),
    );
    expect(api.post).toHaveBeenCalledWith("/api/alerts/dismiss", { id: "late:c1" });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "1 thing needs a look" })).toBeInTheDocument(),
    );

    vi.mocked(api.post).mockResolvedValueOnce(ok({ alerts: [] }));
    await userEvent.click(within(pop).getByRole("button", { name: "Hide all" }));
    expect(api.post).toHaveBeenLastCalledWith("/api/alerts/dismiss", { all: true });
    expect(await within(pop).findByText("All clear")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Nothing needs a look" })).toBeInTheDocument();
  });

  it("Escape closes it", async () => {
    vi.mocked(api.get).mockResolvedValue(ok({ alerts: [] }));
    render(<Bell />);
    await userEvent.click(await screen.findByRole("button", { name: "Nothing needs a look" }));
    expect(screen.getByRole("dialog", { name: "Needs a look" })).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Needs a look" })).not.toBeInTheDocument();
  });
});

describe("light and dark (spec §4.4)", () => {
  it("switches, and remembers the choice", async () => {
    render(<ThemeSwitch />);
    await userEvent.click(screen.getByRole("radio", { name: "Dark" }));
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(localStorage.getItem("lume-licence-theme")).toBe("dark");
    expect(screen.getByRole("radio", { name: "Dark" })).toHaveAttribute("aria-checked", "true");
    await userEvent.click(screen.getByRole("radio", { name: "Light" }));
    expect(localStorage.getItem("lume-licence-theme")).toBe("light");
  });
});

describe("sign-in: password, then six digits (spec §4.4)", () => {
  it("goes to the code step, and six digits sign in", async () => {
    vi.mocked(api.post)
      .mockResolvedValueOnce(ok({ next: "code" }))
      .mockResolvedValueOnce(ok({ ok: true }));
    vi.mocked(api.get).mockResolvedValue(ok({ clients: [{}, {}], alerts: [{}] }));
    render(<SignIn />);
    await userEvent.type(screen.getByLabelText("Email"), "owner@lume.test");
    await userEvent.type(screen.getByLabelText("Password"), "a long and lovely passphrase");
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(api.post).toHaveBeenCalledWith("/api/auth/password", {
      email: "owner@lume.test",
      password: "a long and lovely passphrase",
    });
    expect(await screen.findByText("Two-step sign-in")).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("Code"), "482913");
    expect(api.post).toHaveBeenLastCalledWith("/api/auth/code", { code: "482913" });
    expect(await screen.findByText("Welcome back")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open clients" })).toHaveAttribute("href", "/clients");
  });

  it("a wrong password or code is one message, and back to the start", async () => {
    vi.mocked(api.post)
      .mockResolvedValueOnce(ok({ next: "code" }))
      .mockResolvedValueOnce({
        ok: false,
        status: 401,
        message: "That didn't work. Check the email, password and code, then try again.",
      });
    render(<SignIn />);
    await userEvent.type(screen.getByLabelText("Email"), "owner@lume.test");
    await userEvent.type(screen.getByLabelText("Password"), "not it at all, sorry");
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    await userEvent.type(await screen.findByLabelText("Code"), "000000");
    expect(await screen.findByRole("alert")).toHaveTextContent("That didn't work.");
    expect(screen.getByLabelText("Password")).toHaveValue("");
  });
});

const row = (o: Record<string, unknown>) => ({
  id: "c1",
  name: "Brightpath Studio",
  slug: "brightpath",
  country: "IN",
  region: "MH",
  city: "Pune",
  source: "referrals",
  createdAt: "2026-03-10T09:00:00Z",
  instanceId: "LUME-7F3K-Q9M2",
  keyMasked: "LUME-••••-••••-••••-••••-7Q2F",
  type: "subscription",
  state: "active",
  reason: "paid",
  paidUntil: "2027-03-12",
  trialEnds: null,
  suspendedAt: null,
  decommissionedAt: null,
  price: { currency: "INR", amount: 59988, periodMonths: 12 },
  monthlyInr: 4999,
  lastCheckIn: { at: new Date(Date.now() - 2 * 3_600_000).toISOString(), version: "1.4.2" },
  ...o,
});
const LIST = {
  clients: [
    row({}),
    row({
      id: "c2",
      name: "Harbour Clinic",
      slug: "harbour-clinic",
      region: "KA",
      city: "Bengaluru",
      state: "grace",
      reason: "overdue",
      paidUntil: "2026-09-26",
      price: { currency: "INR", amount: 2999, periodMonths: 1 },
      monthlyInr: 2999,
    }),
    row({
      id: "c3",
      name: "Oakline Realty",
      slug: "oakline",
      country: "AE",
      region: null,
      city: "Dubai",
      price: { currency: "AED", amount: 450, periodMonths: 1 },
      monthlyInr: 10831.5,
      lastCheckIn: { at: new Date().toISOString(), version: "1.3.8" },
    }),
  ],
  totals: { mrr: 18829.5, mrrBefore: 16000 },
  rates: RATES,
  latestVersion: "1.4.2",
  listPriceInr: 3999,
};

describe("Clients (spec §4.4)", () => {
  it("state tiles filter, search narrows, and each row shows its flag, price and state", async () => {
    vi.mocked(api.get).mockImplementation(
      async (p: string) => (p === "/api/alerts" ? ok({ alerts: [] }) : ok(LIST)) as never,
    );
    render(<ClientsScreen />);
    const table = await screen.findByRole("table", { name: "Clients" });
    expect(within(table).getAllByRole("row")).toHaveLength(4); // the head and three clients
    const oak = within(table).getByRole("row", { name: /Oakline Realty/ });
    expect(within(oak).getByRole("img", { name: "United Arab Emirates" })).toHaveAttribute(
      "src",
      "/flags/AE.svg",
    );
    expect(oak).toHaveTextContent("AED 450 a month");
    expect(oak).toHaveTextContent("≈ ₹10,832 a month");
    expect(oak).toHaveTextContent("update");
    const bright = within(table).getByRole("row", { name: /Brightpath Studio/ });
    expect(bright).toHaveTextContent("₹59,988 a year");
    expect(bright).toHaveTextContent("≈ ₹4,999 a month");
    expect(screen.getByRole("link", { name: /Monthly revenue/ })).toHaveTextContent("₹18,830");

    await userEvent.click(screen.getByRole("button", { name: /Grace/ }));
    expect(screen.getByRole("button", { name: /Grace/ })).toHaveAttribute("aria-pressed", "true");
    expect(within(table).getAllByRole("row")).toHaveLength(2);

    await userEvent.click(screen.getByRole("button", { name: /All clients/ }));
    await userEvent.type(screen.getByRole("searchbox", { name: "Search clients" }), "dubai");
    expect(within(table).getAllByRole("row")).toHaveLength(2);
    await userEvent.clear(screen.getByRole("searchbox", { name: "Search clients" }));
    await userEvent.type(screen.getByRole("searchbox", { name: "Search clients" }), "nobody");
    expect(screen.getByText("No client matches that.")).toBeInTheDocument();
  });

  it("New licence: the live rupee line, then the key, shown once", async () => {
    vi.mocked(api.get).mockImplementation(
      async (p: string) => (p === "/api/alerts" ? ok({ alerts: [] }) : ok(LIST)) as never,
    );
    render(<ClientsScreen />);
    await userEvent.click(await screen.findByRole("button", { name: "New licence" }));
    const sheet = screen.getByRole("dialog", { name: "New licence" });
    expect(within(sheet).getByRole("button", { name: "Create licence" })).toBeDisabled();
    await userEvent.type(within(sheet).getByLabelText("Business name"), "Palm Bay Clinic");
    await userEvent.selectOptions(within(sheet).getByLabelText("Country"), "AE");
    // Its home currency, converted at today's rate from the ₹3,999 default.
    expect(within(sheet).getByLabelText("Currency")).toHaveValue("AED");
    expect(within(sheet).getByLabelText("Price")).toHaveValue("166");
    await userEvent.clear(within(sheet).getByLabelText("Price"));
    await userEvent.type(within(sheet).getByLabelText("Price"), "450");
    expect(within(sheet).getByText("≈ ₹10,832 a month in your analytics")).toBeInTheDocument();
    expect(within(sheet).getByText("171% above your ₹3,999 list price.")).toBeInTheDocument();
    await userEvent.type(within(sheet).getByLabelText("City"), "Dubai");

    vi.mocked(api.post).mockResolvedValueOnce(
      ok({
        client: row({ id: "c9", name: "Palm Bay Clinic", country: "AE" }),
        licenseKey: "LUME-K7PX-2MWD-9RTA-4QZC-7Q2F",
      }),
    );
    await userEvent.click(within(sheet).getByRole("button", { name: "Create licence" }));
    expect(api.post).toHaveBeenCalledWith("/api/clients", {
      name: "Palm Bay Clinic",
      country: "AE",
      region: null,
      city: "Dubai",
      source: "referrals",
      plan: { type: "subscription", currency: "AED", amount: 450, periodMonths: 1 },
    });
    const done = await screen.findByRole("dialog", { name: "Licence created" });
    expect(within(done).getByText("LUME-K7PX-2MWD-9RTA-4QZC-7Q2F")).toBeInTheDocument();
    expect(done).toHaveTextContent("Shown once");
    expect(within(done).getByRole("link", { name: "Open Palm Bay Clinic" })).toHaveAttribute(
      "href",
      "/clients/c9",
    );
  });
});

const DETAIL = {
  client: row({
    id: "c2",
    name: "Harbour Clinic",
    slug: "harbour-clinic",
    region: "KA",
    city: "Bengaluru",
    state: "grace",
    reason: "overdue",
    paidUntil: "2026-09-26",
    price: { currency: "INR", amount: 2999, periodMonths: 1 },
    monthlyInr: 2999,
  }),
  installation: {
    version: "1.4.2",
    ip: "198.51.100.7",
    activeUsers: 6,
    leadCount: 1284,
    lastCheckInAt: "2026-09-28T09:12:00Z",
    serverTime: null,
  },
  checkIns: Array.from({ length: 56 }, (_, i) => ({
    from: new Date(Date.now() - (56 - i) * 6 * 3_600_000).toISOString(),
    seen: i < 51,
  })),
  history: [{ at: "2026-07-26T09:00:00Z", kind: "created", detail: { type: "subscription" } }],
  payments: [],
  notice: null,
  rates: RATES,
  listPriceInr: 3999,
};

describe("one client's actions (spec §4.4)", () => {
  beforeEach(() => {
    vi.mocked(api.get).mockImplementation(
      async (p: string) => (p === "/api/alerts" ? ok({ alerts: [] }) : ok(DETAIL)) as never,
    );
  });

  it("Suspend asks inline first; Keep it changes nothing", async () => {
    render(<ClientScreen id="c2" />);
    await userEvent.click(await screen.findByRole("button", { name: "Suspend…" }));
    expect(screen.getByText("Suspend Harbour Clinic?")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Keep it" }));
    expect(api.post).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Suspend…" }));
    vi.mocked(api.post).mockResolvedValueOnce(
      ok({
        ...DETAIL,
        client: { ...DETAIL.client, state: "suspended", suspendedAt: "2026-09-29T10:00:00Z" },
      }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Suspend" }));
    expect(api.post).toHaveBeenCalledWith("/api/clients/c2/suspend");
    expect(await screen.findByRole("status")).toHaveTextContent("Harbour Clinic is suspended");
    expect(screen.getByRole("button", { name: "Resume" })).toBeInTheDocument();
  });

  it("Rotate types the new key out once, with Copy", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<ClientScreen id="c2" />);
    vi.mocked(api.post).mockResolvedValueOnce(ok({ ...DETAIL, licenseKey: "LUME-K7PX-2MWD-9RTA-4QZC-8HNW" }));
    await user.click(await screen.findByRole("button", { name: "Rotate key" }));
    await act(async () => vi.advanceTimersByTime(3000));
    expect(screen.getByText("LUME-K7PX-2MWD-9RTA-4QZC-8HNW")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy" })).toBeInTheDocument();
    expect(screen.getByText(/Shown once/)).toBeInTheDocument();
    vi.useRealTimers();
  });

  it("the reminder: a note, Send, then Reminder on with Stop", async () => {
    render(<ClientScreen id="c2" />);
    await userEvent.click(await screen.findByRole("button", { name: "Send payment reminder" }));
    const note = screen.getByLabelText("Your note (optional)");
    await userEvent.clear(note);
    await userEvent.type(note, "UPI is fine.");
    vi.mocked(api.post).mockResolvedValueOnce(
      ok({
        ...DETAIL,
        notice: { id: "n1", note: "UPI is fine.", dueDate: "2026-09-26", createdAt: "2026-09-29T10:00:00Z" },
      }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Send reminder" }));
    expect(api.post).toHaveBeenCalledWith("/api/clients/c2/reminder", { note: "UPI is fine." });
    expect(await screen.findByText("Reminder on.")).toBeInTheDocument();
    vi.mocked(api.del).mockResolvedValueOnce(ok(DETAIL));
    await userEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(api.del).toHaveBeenCalledWith("/api/clients/c2/reminder");
    await waitFor(() => expect(screen.queryByText("Reminder on.")).not.toBeInTheDocument());
  });

  it("Change price: a new currency converts the typed price at today's rate", async () => {
    render(<ClientScreen id="c2" />);
    await userEvent.click(await screen.findByRole("button", { name: "Change" }));
    await userEvent.selectOptions(screen.getByLabelText("Currency"), "AED");
    expect(screen.getByLabelText("Price")).toHaveValue("125");
    expect(
      screen.getByText("Converted from ₹2,999 at today's rate. Round it however you like."),
    ).toBeInTheDocument();
    vi.mocked(api.post).mockResolvedValueOnce(ok(DETAIL));
    await userEvent.click(screen.getByRole("button", { name: "Save price" }));
    expect(api.post).toHaveBeenCalledWith("/api/clients/c2/price", {
      currency: "AED",
      amount: 125,
      periodMonths: 1,
    });
  });

  it("Mark paid and Extend", async () => {
    render(<ClientScreen id="c2" />);
    vi.mocked(api.post).mockResolvedValueOnce(
      ok({ ...DETAIL, client: { ...DETAIL.client, paidUntil: "2026-10-29", state: "active" } }),
    );
    await userEvent.click(await screen.findByRole("button", { name: "Mark paid" }));
    expect(api.post).toHaveBeenCalledWith("/api/clients/c2/paid", {});
    expect(await screen.findByRole("status")).toHaveTextContent("Paid until 29 Oct 2026");
    await userEvent.click(screen.getByRole("button", { name: "Extend…" }));
    vi.mocked(api.post).mockResolvedValueOnce(ok(DETAIL));
    await userEvent.click(screen.getByRole("button", { name: "+3 months" }));
    expect(api.post).toHaveBeenLastCalledWith("/api/clients/c2/extend", { months: 3 });
  });
});

describe("decommission (the source spec §6)", () => {
  const suspended = {
    ...DETAIL,
    client: { ...DETAIL.client, state: "suspended", suspendedAt: "2026-09-29T10:00:00Z" },
  };
  it("a suspended client can be decommissioned, after an inline confirm; then its page says so, and offers nothing", async () => {
    vi.mocked(api.get).mockImplementation(
      async (p: string) => (p === "/api/alerts" ? ok({ alerts: [] }) : ok(suspended)) as never,
    );
    render(<ClientScreen id="c2" />);
    await userEvent.click(await screen.findByRole("button", { name: "Decommission…" }));
    expect(screen.getByText(/Decommission Harbour Clinic\? This is for good/)).toBeInTheDocument();
    vi.mocked(api.post).mockResolvedValueOnce(
      ok({ ...suspended, client: { ...suspended.client, decommissionedAt: "2026-09-30T10:00:00Z" } }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Decommission" }));
    expect(api.post).toHaveBeenCalledWith("/api/clients/c2/decommission");
    expect(await screen.findByText(/Decommissioned on 30 Sep 2026/)).toBeInTheDocument();
    for (const name of ["Resume", "Mark paid", "Extend…", "Rotate key", "Send payment reminder", "Change"])
      expect(screen.queryByRole("button", { name })).not.toBeInTheDocument();
  });
  it("an active client has no Decommission", async () => {
    vi.mocked(api.get).mockImplementation(
      async (p: string) => (p === "/api/alerts" ? ok({ alerts: [] }) : ok(DETAIL)) as never,
    );
    render(<ClientScreen id="c2" />);
    await screen.findByRole("button", { name: "Suspend…" });
    expect(screen.queryByRole("button", { name: "Decommission…" })).not.toBeInTheDocument();
  });
});

describe("analytics cards follow the trend rule (spec §4.5)", () => {
  const data = (clients = CANVAS_CLIENTS) => ({
    ...computeAnalytics({
      clients,
      rates: CANVAS_RATES,
      now: CANVAS_NOW,
      range: 12,
      listPriceInr: CANVAS_LIST_PRICE,
    }),
    rates: { day: "2026-09-29", ageDays: 0, rates: CANVAS_RATES },
  });

  it("growing: a green growth card with an up arrow; revenue up is a green chip", async () => {
    vi.mocked(api.get).mockImplementation(
      async (p: string) => (p === "/api/alerts" ? ok({ alerts: [] }) : ok(data())) as never,
    );
    render(<AnalyticsScreen />);
    const growth = await screen.findByRole("region", { name: "Monthly growth" });
    expect(growth).toHaveClass("hero", "good");
    expect(growth).toHaveTextContent("+43.9%");
    const mrr = screen.getByRole("region", { name: "Monthly revenue" });
    expect(within(mrr).getByText("+17.2% vs Aug").closest(".delta")).toHaveClass("good");
    // More clients lost is bad: a red chip pointing up.
    const lost = screen.getByRole("region", { name: "Clients lost" });
    expect(lost.querySelector(".delta")).toHaveClass("bad");
    expect(lost.querySelector(".delta")).toHaveAttribute("data-dir", "up");
  });

  it("declining: monthly revenue down is a red chip with a true minus", async () => {
    vi.mocked(api.get).mockImplementation(
      async (p: string) => (p === "/api/alerts" ? ok({ alerts: [] }) : ok(data(CANVAS_DECLINING))) as never,
    );
    render(<AnalyticsScreen />);
    const mrr = await screen.findByRole("region", { name: "Monthly revenue" });
    expect(within(mrr).getByText("−34.1% vs Aug").closest(".delta")).toHaveClass("bad");
    await userEvent.click(screen.getByRole("radio", { name: "3M" }));
    expect(api.get).toHaveBeenLastCalledWith("/api/analytics?range=3");
  });
});
