// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/lib/client";
import { computeAnalytics } from "@/lib/analytics";
import { CANVAS_CLIENTS, CANVAS_DECLINING, CANVAS_LIST_PRICE, CANVAS_NOW, CANVAS_RATES } from "@/lib/fixture";
import { AnalyticsScreen } from "./AnalyticsScreen";
import { Bell } from "./Bell";
import { ClientScreen } from "./ClientScreen";
import { ClientsScreen } from "./ClientsScreen";
import { PaymentsScreen } from "./PaymentsScreen";
import { SignIn } from "./SignIn";
import { clientMessage, whatsappLink } from "@/lib/message";
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

const clipboard = { writeText: vi.fn(() => Promise.resolve()) };
Object.defineProperty(navigator, "clipboard", { value: clipboard, configurable: true });

beforeEach(() => {
  clipboard.writeText.mockClear();
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

  it("a key nobody entered: Copy message fetches the key and copies the ready-to-send text", async () => {
    const idle = {
      id: "idle-key:c4",
      fingerprint: "2026-10-06T08:00:00Z",
      tone: "grey",
      title: "Not activated after 9 days — Coral Bay Physio",
      body: "Key issued 6 Oct. Send the message again?",
      clientId: "c4",
      clientName: "Coral Bay Physio",
      action: { kind: "copy_message", slug: "coral-bay" },
    };
    vi.mocked(api.get).mockImplementation(
      async (p: string) =>
        (p === "/api/alerts"
          ? ok({ alerts: [idle] })
          : ok({ licenseKey: "LUME-C0RA-LBAY-0000-0000-0004" })) as never,
    );
    render(<Bell />);
    await userEvent.click(await screen.findByRole("button", { name: "1 thing needs a look" }));
    await userEvent.click(screen.getByRole("button", { name: "Copy message" }));
    expect(api.get).toHaveBeenCalledWith("/api/clients/c4/key");
    expect(clipboard.writeText).toHaveBeenLastCalledWith(
      clientMessage("coral-bay", "LUME-C0RA-LBAY-0000-0000-0004"),
    );
    expect(await screen.findByRole("button", { name: "Copied" })).toBeInTheDocument();
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
  keyShowable: true,
  activation: {
    status: "active",
    ip: "203.0.113.10",
    at: "2026-10-01T09:00:00Z",
    installId: "0190e0c0-0000-7000-8000-0000000000a1",
  },
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

  it("a licence nobody has entered yet: its own pill, and a Not activated tile that filters to it", async () => {
    const waiting = row({
      id: "c4",
      name: "Coral Bay Physio",
      slug: "coral-bay",
      lastCheckIn: null,
      activation: { status: "not_activated", ip: null, at: null, installId: null },
    });
    vi.mocked(api.get).mockImplementation(
      async (p: string) =>
        (p === "/api/alerts"
          ? ok({ alerts: [] })
          : ok({ ...LIST, clients: [...LIST.clients, waiting] })) as never,
    );
    render(<ClientsScreen />);
    const table = await screen.findByRole("table", { name: "Clients" });
    expect(within(table).getByRole("row", { name: /Coral Bay Physio/ })).toHaveTextContent("Not activated");
    await userEvent.click(screen.getByRole("button", { name: /Not activated/ }));
    expect(within(table).getAllByRole("row")).toHaveLength(2); // the head and the one waiting
  });

  it("New licence: the live rupee line, then the key, ready to send", async () => {
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
    const done = await screen.findByRole("dialog", { name: "Ready to send" });
    expect(within(done).getAllByText("LUME-K7PX-2MWD-9RTA-4QZC-7Q2F").length).toBeGreaterThan(0);
    expect(done).toHaveTextContent("Licence created for Palm Bay Clinic");
    expect(done).toHaveTextContent("Not activated yet.");
    const message = clientMessage("brightpath", "LUME-K7PX-2MWD-9RTA-4QZC-7Q2F");
    expect(done).toHaveTextContent(message);
    await userEvent.click(within(done).getByRole("button", { name: "Copy key" }));
    expect(clipboard.writeText).toHaveBeenLastCalledWith("LUME-K7PX-2MWD-9RTA-4QZC-7Q2F");
    await userEvent.click(within(done).getByRole("button", { name: "Copy message" }));
    expect(clipboard.writeText).toHaveBeenLastCalledWith(message);
    expect(within(done).getByRole("link", { name: "Send on WhatsApp" })).toHaveAttribute(
      "href",
      whatsappLink(message),
    );
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

describe("the Licence key card (spec 2026-10-15 §3.2)", () => {
  const withKey = (activation: Record<string, unknown>, over: Record<string, unknown> = {}) => ({
    ...DETAIL,
    client: { ...DETAIL.client, activation: { ...DETAIL.client.activation, ...activation }, ...over },
  });
  const serve = (detail: unknown, extra: Record<string, unknown> = {}) =>
    vi
      .mocked(api.get)
      .mockImplementation(
        async (p: string) =>
          (p === "/api/alerts" ? ok({ alerts: [] }) : p in extra ? ok(extra[p]) : ok(detail)) as never,
      );
  const card = () => screen.findByRole("region", { name: "Licence key" });
  const gone = { status: "not_activated", ip: null, at: null, installId: null };

  it("says where the key is: active on a server, not activated yet, or released", async () => {
    serve(DETAIL);
    const first = render(<ClientScreen id="c2" />);
    expect(await card()).toHaveTextContent("Active on 203.0.113.10");
    first.unmount();
    serve(withKey(gone));
    const second = render(<ClientScreen id="c2" />);
    expect(await card()).toHaveTextContent("Not activated yet");
    expect(screen.queryByRole("button", { name: "Release key" })).not.toBeInTheDocument();
    second.unmount();
    serve(withKey({ ...gone, status: "released" }));
    render(<ClientScreen id="c2" />);
    expect(await card()).toHaveTextContent("Released — the next server to enter it takes it");
  });

  it("Show fetches the key and shows it; Copy message copies the ready-to-send text", async () => {
    serve(DETAIL, { "/api/clients/c2/key": { licenseKey: "LUME-K7PX-2MWD-9RTA-4QZC-7Q2F" } });
    render(<ClientScreen id="c2" />);
    const c = await card();
    await userEvent.click(within(c).getByRole("button", { name: "Show" }));
    expect(await within(c).findByText("LUME-K7PX-2MWD-9RTA-4QZC-7Q2F")).toBeInTheDocument();
    await userEvent.click(within(c).getByRole("button", { name: "Copy message for client" }));
    expect(clipboard.writeText).toHaveBeenLastCalledWith(
      clientMessage("harbour-clinic", "LUME-K7PX-2MWD-9RTA-4QZC-7Q2F"),
    );
  });

  it("history: the old key a Rotate retired reads apart from a key held to decommission", async () => {
    serve({
      ...DETAIL,
      history: [
        { at: "2026-10-15T10:02:00Z", kind: "key_decommissioned", detail: { last4: "8HNW", via: "hold" } },
        { at: "2026-10-15T10:01:00Z", kind: "key_decommissioned", detail: { last4: "7Q2F", via: "rotate" } },
        { at: "2026-10-15T10:01:00Z", kind: "key_rotated", detail: { last4: "8HNW" } },
      ],
    });
    render(<ClientScreen id="c2" />);
    const history = await screen.findByRole("region", { name: "History" });
    expect(history).toHaveTextContent("Old key decommissioned by the rotate");
    expect(within(history).getAllByText("Key decommissioned")).toHaveLength(1);
  });

  it("Release asks first, naming the server", async () => {
    serve(DETAIL);
    render(<ClientScreen id="c2" />);
    await userEvent.click(await screen.findByRole("button", { name: "Release key" }));
    const ask = screen.getByRole("group", { name: "Release from 203.0.113.10?" });
    vi.mocked(api.post).mockResolvedValueOnce(ok(withKey({ ...gone, status: "released" })));
    await userEvent.click(within(ask).getByRole("button", { name: "Release key" }));
    expect(api.post).toHaveBeenCalledWith("/api/clients/c2/release");
    expect(await card()).toHaveTextContent("Released");
  });

  it("hold to decommission: a short press does nothing; a full hold decommissions once; then Issue a new key", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.stubGlobal(
      "requestAnimationFrame",
      (cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 16) as unknown as number,
    );
    vi.stubGlobal("cancelAnimationFrame", (h: number) => clearTimeout(h));
    serve(DETAIL);
    render(<ClientScreen id="c2" />);
    const hold = await screen.findByRole("button", { name: "Hold to decommission key" });
    fireEvent.pointerDown(hold, { button: 0, pointerId: 1 });
    await act(async () => vi.advanceTimersByTime(600));
    fireEvent.pointerUp(hold, { pointerId: 1 });
    await act(async () => vi.advanceTimersByTime(600));
    expect(api.post).not.toHaveBeenCalled();
    vi.mocked(api.post).mockResolvedValueOnce(
      ok(withKey({ ...gone, status: "decommissioned" }, { keyShowable: false })),
    );
    fireEvent.pointerDown(hold, { button: 0, pointerId: 1 });
    await act(async () => vi.advanceTimersByTime(1700));
    expect(api.post).toHaveBeenCalledTimes(1);
    expect(api.post).toHaveBeenCalledWith("/api/clients/c2/key/decommission");
    expect(await card()).toHaveTextContent("Key decommissioned");
    vi.mocked(api.post).mockResolvedValueOnce(
      ok({ ...withKey(gone), licenseKey: "LUME-NEW0-KEY0-0000-0000-0001" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Issue a new key" }));
    await waitFor(() => expect(api.post).toHaveBeenLastCalledWith("/api/clients/c2/key/issue"));
    await act(async () => vi.advanceTimersByTime(3000));
    expect(screen.getByText("LUME-NEW0-KEY0-0000-0000-0001")).toBeInTheDocument();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("decommissioning a key just rotated in this visit: the new key and its 7-day words go, Issue a new key shows", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.stubGlobal(
      "requestAnimationFrame",
      (cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 16) as unknown as number,
    );
    vi.stubGlobal("cancelAnimationFrame", (h: number) => clearTimeout(h));
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    serve(DETAIL);
    render(<ClientScreen id="c2" />);
    await user.click(await screen.findByRole("button", { name: "Rotate key" }));
    vi.mocked(api.post).mockResolvedValueOnce(ok({ ...DETAIL, licenseKey: "LUME-K7PX-2MWD-9RTA-4QZC-8HNW" }));
    await user.click(
      within(screen.getByRole("group", { name: "Rotate the key?" })).getByRole("button", {
        name: "Rotate key",
      }),
    );
    await act(async () => vi.advanceTimersByTime(3000));
    expect(await card()).toHaveTextContent("keeps working on it for 7 days");
    vi.mocked(api.post).mockResolvedValueOnce(
      ok(withKey({ ...gone, status: "decommissioned" }, { keyShowable: false })),
    );
    const hold = screen.getByRole("button", { name: "Hold to decommission key" });
    fireEvent.pointerDown(hold, { button: 0, pointerId: 1 });
    await act(async () => vi.advanceTimersByTime(1700));
    expect(api.post).toHaveBeenLastCalledWith("/api/clients/c2/key/decommission");
    const c = await card();
    await waitFor(() => expect(c).toHaveTextContent("Key decommissioned."));
    expect(c).not.toHaveTextContent("LUME-K7PX-2MWD-9RTA-4QZC-8HNW");
    expect(c).not.toHaveTextContent("7 days");
    expect(within(c).getByRole("button", { name: "Issue a new key" })).toBeInTheDocument();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });
});

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

  it("Rotate asks first, then types the new key out with Copy; the old key is decommissioned", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<ClientScreen id="c2" />);
    await user.click(await screen.findByRole("button", { name: "Rotate key" }));
    const ask = screen.getByRole("group", { name: "Rotate the key?" });
    expect(ask).toHaveTextContent("decommissioned");
    vi.mocked(api.post).mockResolvedValueOnce(ok({ ...DETAIL, licenseKey: "LUME-K7PX-2MWD-9RTA-4QZC-8HNW" }));
    await user.click(within(ask).getByRole("button", { name: "Rotate key" }));
    expect(api.post).toHaveBeenCalledWith("/api/clients/c2/rotate");
    await act(async () => vi.advanceTimersByTime(3000));
    expect(screen.getByText("LUME-K7PX-2MWD-9RTA-4QZC-8HNW")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy" })).toBeInTheDocument();
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
    expect(await screen.findByRole("status")).toHaveTextContent("Paid until Oct 29, 2026");
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
    expect(await screen.findByText(/Decommissioned on Sep 30, 2026/)).toBeInTheDocument();
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

describe("the chart's tooltip follows the trend rule too", () => {
  it("a change that rounds to no change never shows +0.0%; the first month compares with the one before", async () => {
    const base = computeAnalytics({
      clients: CANVAS_CLIENTS,
      rates: CANVAS_RATES,
      now: CANVAS_NOW,
      range: 3,
      listPriceInr: CANVAS_LIST_PRICE,
    });
    const series = base.series.map((p, i) => ({ ...p, mrr: i === 3 ? 66010 : i === 2 ? 66000 : p.mrr }));
    vi.mocked(api.get).mockImplementation(
      async (p: string) =>
        (p === "/api/alerts"
          ? ok({ alerts: [] })
          : ok({
              ...base,
              series,
              beforeRange: 50000,
              rates: { day: "2026-09-29", ageDays: 0, rates: CANVAS_RATES },
            })) as never,
    );
    const { container } = render(<AnalyticsScreen />);
    await screen.findByRole("region", { name: "Monthly growth" });
    fireEvent.mouseEnter(container.querySelector('[data-month="2026-09"]')!);
    const tip = container.querySelector(".tip")!;
    expect(tip).toHaveTextContent("+₹10");
    expect(tip).not.toHaveTextContent("0.0%");
    fireEvent.mouseEnter(container.querySelector('[data-month="2026-06"]')!);
    expect(container.querySelector(".tip")).toHaveTextContent("(\u2212");
  });
});

describe("one client (the first sale)", () => {
  it("is a client, not 1 clients", async () => {
    const base = computeAnalytics({
      clients: CANVAS_CLIENTS.slice(0, 1),
      rates: CANVAS_RATES,
      now: CANVAS_NOW,
      range: 3,
      listPriceInr: CANVAS_LIST_PRICE,
    });
    vi.mocked(api.get).mockImplementation(
      async (p: string) =>
        (p === "/api/alerts"
          ? ok({ alerts: [] })
          : ok({ ...base, rates: { day: "2026-09-29", ageDays: 0, rates: CANVAS_RATES } })) as never,
    );
    render(<AnalyticsScreen />);
    expect(await screen.findByText("1 client in 1 country")).toBeInTheDocument();
    expect(screen.queryByText(/1 clients/)).toBeNull();
  });
});

describe("payments", () => {
  it("a payment made on a day with no fresh rate says which day's rate it used", async () => {
    const pay = (id: string, paidAt: string, rateDay: string) => ({
      id,
      clientId: "c" + id,
      clientName: "Client " + id,
      amount: 25,
      currency: "USD",
      rateToInr: 88.4,
      rateDay,
      amountInr: 2210,
      paidAt,
      paidUntil: "2026-11-02",
      note: null,
    });
    vi.mocked(api.get).mockResolvedValue(
      ok({
        payments: [
          pay("1", "2026-10-02T09:00:00Z", "2026-09-29"),
          pay("2", "2026-09-29T09:00:00Z", "2026-09-29"),
        ],
      }) as never,
    );
    render(<PaymentsScreen />);
    const late = (await screen.findByText("Client 1")).closest("tr")!;
    expect(late).toHaveTextContent("at ₹88.40, the rate of Sep 29");
    const same = screen.getByText("Client 2").closest("tr")!;
    expect(same).toHaveTextContent("at ₹88.40");
    expect(same).not.toHaveTextContent("the rate of");
  });
});

describe("a paused client's price", () => {
  it("says it isn't counted while paused, not that there's no rate", async () => {
    const paused = {
      ...DETAIL,
      client: {
        ...DETAIL.client,
        state: "suspended",
        suspendedAt: "2026-09-29T10:00:00Z",
        price: { currency: "USD", amount: 948, periodMonths: 12 },
        monthlyInr: 0,
      },
    };
    vi.mocked(api.get).mockImplementation(
      async (p: string) => (p === "/api/alerts" ? ok({ alerts: [] }) : ok(paused)) as never,
    );
    render(<ClientScreen id="c2" />);
    const card = await screen.findByRole("region", { name: "Plan and price" });
    expect(card).toHaveTextContent("not counted while paused");
    expect(card).not.toHaveTextContent("no rate");
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
