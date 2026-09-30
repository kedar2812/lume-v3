import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LICENCE_REFUSED, licenceClient, type LicenceForPerson } from "@/lib/licence/client";
import { fakeSession } from "@/server/session";
import { LicenceBanner } from "./LicenceBanner";
import { LicenceCard } from "./LicenceCard";
import { LicenceProvider } from "./LicenceProvider";
import { LockScreen } from "./LockScreen";
import { PaymentReminder } from "./PaymentReminder";

vi.mock("@/lib/licence/client", async (orig) => ({
  ...(await orig<typeof import("@/lib/licence/client")>()),
  licenceClient: { get: vi.fn(), check: vi.fn(), dismiss: vi.fn() },
}));
let reduce = false;
vi.mock("motion/react", async (orig) => ({
  ...(await orig<typeof import("motion/react")>()),
  useReducedMotion: () => reduce,
}));

const ok = <T,>(data: T) => ({ ok: true as const, status: 200, data });
const L = (over: Partial<LicenceForPerson> = {}): LicenceForPerson => ({
  state: "active",
  reason: "paid",
  graceEndsAt: null,
  licenseType: "subscription",
  paidUntil: "2027-03-12",
  trialEndsAt: null,
  notice: null,
  checkedAt: new Date(Date.now() - 2 * 3_600_000).toISOString(),
  dev: false,
  instanceId: "LUME-7F3K-Q9M2",
  nextCheckAt: new Date(Date.now() + 4 * 3_600_000).toISOString(),
  showNotice: false,
  canCheck: false,
  lastError: null,
  ...over,
});
const ADMIN = [
  { key: "settings.manage" as const, scope: null },
  { key: "data.export" as const, scope: null },
];
const admin = (licence: LicenceForPerson) =>
  fakeSession({ permissions: ADMIN, licence: { ...licence, canCheck: true } });
const rep = (licence: LicenceForPerson) => fakeSession({ licence });

function shell(session: ReturnType<typeof fakeSession>, ui: React.ReactNode) {
  return render(<LicenceProvider session={session}>{ui}</LicenceProvider>);
}

beforeEach(() => {
  vi.clearAllMocks();
  reduce = false;
  vi.mocked(licenceClient.get).mockImplementation(async () => ok(L()));
});
afterEach(() => vi.useRealTimers());

describe("the grace banner (L-A Task 5)", () => {
  it("admins only: why, and Check now", async () => {
    const lic = L({
      state: "grace",
      reason: "unreachable",
      checkedAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
    });
    shell(admin(lic), <LicenceBanner />);
    const banner = screen.getByRole("status");
    expect(banner).toHaveTextContent("LUME couldn't reach its licence server for 2 days.");
    expect(banner).toHaveTextContent("Only admins see this.");
    vi.mocked(licenceClient.check).mockResolvedValue(ok({ ...L(), canCheck: true }));
    await userEvent.click(within(banner).getByRole("button", { name: "Check now" }));
    expect(licenceClient.check).toHaveBeenCalled();
    // It goes back up the way it came.
    await waitFor(() => expect(screen.queryByRole("status")).not.toBeInTheDocument());
  });

  it("a late payment says until when; a rep sees nothing", () => {
    const lic = L({ state: "grace", reason: "overdue", graceEndsAt: "2026-10-04T00:00:00.000Z" });
    const { unmount } = shell(admin(lic), <LicenceBanner />);
    expect(screen.getByRole("status")).toHaveTextContent("Everything works as usual until 4 Oct.");
    unmount();
    shell(rep(lic), <LicenceBanner />);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});

describe("read-only", () => {
  it("everyone sees the blue bar; those who may, Export all data", () => {
    shell(rep(L({ state: "read_only", reason: "overdue" })), <LicenceBanner />);
    const bar = screen.getByRole("status");
    expect(bar).toHaveTextContent("Read-only. The licence needs attention");
    expect(bar).toHaveAttribute("data-tone", "read_only");
    expect(within(bar).queryByRole("button", { name: "Export all data" })).not.toBeInTheDocument();
  });

  it("a write refused for the licence makes the shell look again", async () => {
    vi.mocked(licenceClient.get).mockResolvedValue(ok(L({ state: "read_only", reason: "overdue" })));
    shell(rep(L()), <LicenceBanner />);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    await act(
      async () =>
        void window.dispatchEvent(new CustomEvent(LICENCE_REFUSED, { detail: "LICENSE_READ_ONLY" })),
    );
    expect(await screen.findByRole("status")).toHaveTextContent("Read-only.");
  });
});

describe("suspended: the lock screen", () => {
  it("LUME is paused, for everyone; only those who may export get the button", () => {
    const { unmount } = shell(rep(L({ state: "suspended", reason: "suspended" })), <LockScreen />);
    const lock = screen.getByRole("alertdialog", { name: "LUME is paused" });
    expect(within(lock).getByRole("heading", { name: "LUME is paused" })).toBeInTheDocument();
    expect(within(lock).queryByRole("button", { name: "Export all data" })).not.toBeInTheDocument();
    expect(lock).toHaveTextContent("To carry on, contact whoever licensed LUME to you.");
    unmount();
    shell(admin(L({ state: "suspended", reason: "suspended" })), <LockScreen />);
    expect(screen.getByRole("button", { name: "Export all data" })).toBeInTheDocument();
  });

  it("Export all data ticks through the files, then the zip is ready to download", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("zip", {
        status: 200,
        headers: { "content-disposition": 'attachment; filename="LUME-export-2026-09-30.zip"' },
      }),
    );
    URL.createObjectURL = vi.fn(() => "blob:lume-export");
    URL.revokeObjectURL = vi.fn();
    shell(admin(L({ state: "suspended", reason: "suspended" })), <LockScreen />);
    await userEvent.click(screen.getByRole("button", { name: "Export all data" }));
    const files = await screen.findByRole("list", { name: "Export" });
    expect(
      within(files)
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual(["Leads.csv", "Notes.csv", "Activity.csv", "Follow-ups.csv", "Users.csv", "LUME-export.xlsx"]);
    const link = await screen.findByRole("link", { name: "Download" }, { timeout: 4000 });
    expect(link).toHaveAttribute("href", "blob:lume-export");
    expect(link).toHaveAttribute("download", "LUME-export-2026-09-30.zip");
    expect(screen.getByText("LUME-export-2026-09-30.zip")).toBeInTheDocument();
  });

  it("people who may check can check again from the lock screen; a lifted pause lets LUME carry on", async () => {
    vi.mocked(licenceClient.check).mockResolvedValue(
      ok({ ...L({ checkedAt: new Date().toISOString() }), canCheck: true }),
    );
    shell(admin(L({ state: "suspended", reason: "suspended" })), <LockScreen />);
    await userEvent.click(screen.getByRole("button", { name: "Check again" }));
    expect(licenceClient.check).toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
  });

  it("a rep has no Check again, and a check that's still paused says so", async () => {
    const { unmount } = shell(rep(L({ state: "suspended", reason: "suspended" })), <LockScreen />);
    expect(screen.queryByRole("button", { name: "Check again" })).not.toBeInTheDocument();
    unmount();
    vi.mocked(licenceClient.check).mockResolvedValue(
      ok({ ...L({ state: "suspended", reason: "suspended" }), canCheck: true }),
    );
    shell(admin(L({ state: "suspended", reason: "suspended" })), <LockScreen />);
    await userEvent.click(screen.getByRole("button", { name: "Check again" }));
    expect(await screen.findByText("Still paused. LUME checked just now.")).toBeInTheDocument();
  });

  it("nothing shows while the licence isn't suspended", () => {
    shell(admin(L()), <LockScreen />);
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });
});

describe("the payment reminder", () => {
  const notice = {
    id: "n1",
    kind: "payment_due" as const,
    dueDate: "2026-09-26",
    note: "Hi! A gentle reminder for September.",
    contact: "mailto:billing@lumecrm.in",
  };

  it("owners and admins see it: when it was due, the note, and how to reach the provider", () => {
    shell(admin(L({ notice, showNotice: true })), <PaymentReminder businessName="Harbour Clinic" />);
    const d = screen.getByRole("dialog", { name: "Your LUME payment is due" });
    expect(d).toHaveTextContent("The licence for Harbour Clinic was due on 26 Sep.");
    expect(d).toHaveTextContent("A note from your LUME provider");
    expect(d).toHaveTextContent("Hi! A gentle reminder for September.");
    expect(within(d).getByRole("link", { name: "Contact about payment" })).toHaveAttribute(
      "href",
      "mailto:billing@lumecrm.in",
    );
    expect(d).toHaveTextContent("Shown to owners and admins at each sign-in until it's paid.");
  });

  it("I'll sort it closes it for this session", async () => {
    vi.mocked(licenceClient.dismiss).mockResolvedValue({ ok: true, status: 204, data: null });
    shell(admin(L({ notice, showNotice: true })), <PaymentReminder businessName="Harbour Clinic" />);
    await userEvent.click(screen.getByRole("button", { name: "I'll sort it" }));
    expect(licenceClient.dismiss).toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("never for someone the API didn't show it to (a rep)", () => {
    shell(rep(L({ notice, showNotice: false })), <PaymentReminder businessName="Harbour Clinic" />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("looks again a few seconds after sign-in, so a reminder the sign-in's check brought shows", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.mocked(licenceClient.get).mockResolvedValue(ok(L({ notice, showNotice: true, canCheck: true })));
    shell(admin(L()), <PaymentReminder businessName="Harbour Clinic" />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await act(async () => void vi.advanceTimersByTime(5000));
    expect(await screen.findByRole("dialog", { name: "Your LUME payment is due" })).toBeInTheDocument();
  });
});

describe("Settings → About: the licence card", () => {
  it("says the state, the type, paid until, this installation and the check-ins", () => {
    shell(rep(L()), <LicenceCard />);
    const card = screen.getByRole("region", { name: "Licence" });
    expect(card).toHaveTextContent("Active");
    expect(card).toHaveTextContent("Subscription");
    expect(card).toHaveTextContent("12 Mar 2027");
    expect(card).toHaveTextContent("LUME-7F3K-Q9M2");
    expect(card).toHaveTextContent("2 hours ago");
    expect(within(card).queryByRole("button", { name: "Check now" })).not.toBeInTheDocument();
  });

  it("Check now (admins): spins, then a green tick and all good", async () => {
    vi.mocked(licenceClient.check).mockResolvedValue(
      ok({ ...L({ checkedAt: new Date().toISOString() }), canCheck: true }),
    );
    shell(admin(L()), <LicenceCard />);
    await userEvent.click(screen.getByRole("button", { name: "Check now" }));
    expect(await screen.findByRole("button", { name: "Checked · all good" })).toBeInTheDocument();
    expect(screen.getByTestId("licence-verified")).toBeInTheDocument();
  });

  it("tells an admin why the last check failed", () => {
    shell(admin(L({ lastError: "The licence server didn't recognise this install's key" })), <LicenceCard />);
    expect(screen.getByRole("region", { name: "Licence" })).toHaveTextContent(
      "The licence server didn't recognise this install's key",
    );
  });

  it("perpetual never expires; a development build says so", () => {
    const { unmount } = shell(
      rep(L({ licenseType: "perpetual", paidUntil: null, reason: "perpetual" })),
      <LicenceCard />,
    );
    expect(screen.getByRole("region", { name: "Licence" })).toHaveTextContent("Never expires");
    unmount();
    shell(rep(L({ dev: true, reason: "dev", licenseType: null, paidUntil: null })), <LicenceCard />);
    expect(screen.getByRole("region", { name: "Licence" })).toHaveTextContent("Development licence");
  });

  it("what LUME tells its licence server, in words, and never a lead", () => {
    shell(rep(L()), <LicenceCard />);
    const told = screen.getByRole("region", { name: "What LUME tells its licence server" });
    for (const w of [
      "This installation's ID",
      "Licence key",
      "LUME version",
      "How many people use it",
      "How many leads (a number)",
      "Server time",
    ])
      expect(told).toHaveTextContent(w);
    expect(told).toHaveTextContent("Never a lead's name, number, email or anything they said.");
  });

  it("reduced motion: the ring is drawn at once", () => {
    reduce = true;
    shell(rep(L()), <LicenceCard />);
    expect(screen.getByTestId("licence-ring")).toHaveAttribute("data-motion", "none");
  });
});
