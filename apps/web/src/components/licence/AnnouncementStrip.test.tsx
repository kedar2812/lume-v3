import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { licenceClient, type LicenceForPerson } from "@/lib/licence/client";
import { fakeSession } from "@/server/session";
import { AnnouncementStrip, windowText } from "./AnnouncementStrip";
import { LicenceCard } from "./LicenceCard";
import { LicenceProvider } from "./LicenceProvider";

vi.mock("@/lib/licence/client", async (orig) => ({
  ...(await orig<typeof import("@/lib/licence/client")>()),
  licenceClient: { get: vi.fn(), check: vi.fn(), dismiss: vi.fn(), changeKey: vi.fn(), gotIt: vi.fn() },
}));

const ok = <T,>(data: T) => ({ ok: true as const, status: 200, data });
const A = "0190e0c0-0000-7000-8000-0000000000a1";
const B = "0190e0c0-0000-7000-8000-0000000000b2";
type Ann = LicenceForPerson["announcements"][number];
const ann = (id: string, over: Partial<Ann> = {}): Ann => ({
  id,
  title: id === A ? "LUME will be updated on Sunday night" : "Snooze a follow-up by an hour",
  body:
    id === A
      ? "LUME will be away for about 30 minutes while it’s updated. Anything you’re typing then may need saving again. Nothing else changes for you, and nothing you’ve saved is touched."
      : "A follow-up reminder can now wait an hour.",
  kind: id === A ? "maintenance" : "update",
  audience: "everyone",
  windowStart: id === A ? "2026-10-18T16:30:00.000Z" : null,
  windowEnd: id === A ? "2026-10-18T17:00:00.000Z" : null,
  endsAt: "2099-10-19T00:00:00.000Z",
  gotIt: false,
  ...over,
});
const session = (announcements: Ann[]) =>
  fakeSession({ licence: { ...fakeSession().licence, announcements } });
const show = (announcements: Ann[], zone = "Asia/Kolkata") =>
  render(
    <LicenceProvider session={session(announcements)}>
      <AnnouncementStrip zone={zone} />
    </LicenceProvider>,
  );

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(licenceClient.get).mockImplementation(async () => ok(session([]).licence));
});

describe("From LUME's team (spec 2026-10-16 fleet §4)", () => {
  it("shows one at a time, newest first, with the maintenance window in the reader's own time", () => {
    show([ann(A), ann(B)]);
    const strip = screen.getByRole("region", { name: "From LUME’s team" });
    expect(strip).toHaveTextContent("LUME will be updated on Sunday night");
    expect(strip).toHaveTextContent("Sunday, October 18 · 10:00 – 10:30 pm");
    expect(strip).toHaveTextContent("1 more after this");
    expect(strip).not.toHaveTextContent("Snooze");
  });

  it("Got it is kept, and the next one shows", async () => {
    const user = userEvent.setup();
    vi.mocked(licenceClient.gotIt).mockResolvedValue(
      ok({ ...session([ann(A, { gotIt: true }), ann(B)]).licence }),
    );
    show([ann(A), ann(B)]);
    await user.click(screen.getByRole("button", { name: "Got it" }));
    expect(licenceClient.gotIt).toHaveBeenCalledWith(A);
    await waitFor(() =>
      expect(screen.getByRole("region", { name: "From LUME’s team" })).toHaveTextContent(
        "Snooze a follow-up by an hour",
      ),
    );
  });

  it("long words fold to two lines with More, and nothing shows once each is Got it", async () => {
    const user = userEvent.setup();
    show([ann(A), ann(B, { gotIt: true })]);
    const strip = screen.getByRole("region", { name: "From LUME’s team" });
    expect(strip).not.toHaveTextContent("1 more after this");
    await user.click(within(strip).getByRole("button", { name: "More" }));
    expect(within(strip).getByRole("button", { name: "Less" })).toHaveAttribute("aria-expanded", "true");
  });

  it("is absent when there's nothing, and plain text stays plain", () => {
    const { unmount } = show([]);
    expect(screen.queryByRole("region", { name: "From LUME’s team" })).toBeNull();
    unmount();
    show([ann(B, { title: "<img src=x onerror=alert(1)>" })]);
    expect(screen.getByText("<img src=x onerror=alert(1)>")).toBeInTheDocument();
  });
});

describe("windowText", () => {
  it("one day, the reader's own time; across midnight it says both days", () => {
    expect(windowText("2026-10-18T16:30:00.000Z", "2026-10-18T17:00:00.000Z", "Asia/Kolkata")).toBe(
      "Sunday, October 18 · 10:00 – 10:30 pm",
    );
    expect(windowText("2026-10-18T18:00:00.000Z", "2026-10-18T19:00:00.000Z", "Asia/Kolkata")).toBe(
      "Sunday, October 18, 11:30 pm – Monday, October 19, 12:30 am",
    );
  });
});

describe("Settings → About", () => {
  it("lists every one showing, Got it or not, to read again, and says health goes with the check-in", () => {
    render(
      <LicenceProvider session={session([ann(A, { gotIt: true }), ann(B)])}>
        <LicenceCard />
      </LicenceProvider>,
    );
    const list = screen.getByRole("region", { name: "From LUME’s team, now showing" });
    expect(list).toHaveTextContent("LUME will be updated on Sunday night");
    expect(list).toHaveTextContent("Snooze a follow-up by an hour");
    expect(screen.getByText("Its health: counts and sizes")).toBeInTheDocument();
  });
});
