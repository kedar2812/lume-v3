import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { usersClient } from "@/lib/settings/people";
import type { SecurityActivity } from "@/lib/settings/security";
import { Activity, usualWords } from "./Activity";

vi.mock("@/lib/settings/people", () => ({ usersClient: { endSessions: vi.fn() } }));
const ok = <T,>(data: T) => ({ ok: true as const, status: 200, data });

const day = (today: number, rest = 0) => [...Array<number>(13).fill(rest), today];
const activity = (over: Partial<SecurityActivity> = {}): SecurityActivity => ({
  today: {
    day: "2026-10-03",
    reveals: { count: 58, people: 4 },
    leadsOpened: { count: 412, usual: 400 },
    exports: { count: 2, by: "Maya Kapoor" },
    failedSignIns: { count: 3, name: "Sam Okafor", thenSignedIn: true },
  },
  reveals: [
    { id: "u-rory", name: "Rory Reid", role: "Sales", total: 96, days: day(34, 4), alertToday: true },
    { id: "u-sam", name: "Sam Okafor", role: "Sales", total: 40, days: day(6, 2), alertToday: false },
  ],
  sessions: [
    {
      userId: "u-sam",
      name: "Sam Okafor",
      device: "Safari on iPhone",
      since: new Date(Date.now() - 60_000).toISOString(),
      you: false,
    },
    {
      userId: "u-sam",
      name: "Sam Okafor",
      device: "Chrome on Windows",
      since: "2026-10-02T09:00:00Z",
      you: false,
    },
    {
      userId: "u-me",
      name: "Maya Kapoor",
      device: "Chrome on Mac",
      since: "2026-10-02T04:00:00Z",
      you: true,
    },
  ],
  ...over,
});
const props = { timezone: "Asia/Dubai", canManagePeople: true };

beforeEach(() => vi.clearAllMocks());

describe("Security activity in the Overview (6C Task 3)", () => {
  it("today's four tiles, each opening the Audit log at its own entries", () => {
    render(<Activity data={activity()} {...props} />);
    const tiles = within(screen.getByRole("region", { name: "Today" }));
    const contacts = tiles.getByRole("link", { name: /Contacts opened today/ });
    expect(contacts).toHaveTextContent("58");
    expect(contacts).toHaveTextContent("by 4 people");
    expect(contacts).toHaveAttribute("href", "/settings/audit?action=lead.contact.reveal&day=2026-10-03");
    expect(tiles.getByRole("link", { name: /Leads opened today/ })).toHaveTextContent("about usual");
    const exports = tiles.getByRole("link", { name: /Exports this week/ });
    expect(exports).toHaveTextContent("both by Maya Kapoor");
    expect(exports).toHaveAttribute("href", "/settings/security/exports");
    const failed = tiles.getByRole("link", { name: /Failed sign-ins today/ });
    expect(failed).toHaveTextContent("all Sam Okafor, then signed in");
    expect(failed).toHaveAttribute("href", "/settings/audit?action=user.login.failed&day=2026-10-03");
  });

  it("says how today's leads compare with a usual day, in words", () => {
    expect(usualWords(412, 400)).toBe("about usual");
    expect(usualWords(1200, 400)).toBe("3× usual");
    expect(usualWords(620, 400)).toBe("1.6× usual");
    expect(usualWords(120, 400)).toBe("quieter than usual");
    expect(usualWords(0, 0)).toBe("about usual");
    expect(usualWords(9, 0)).toBe("more than usual");
  });

  it("contacts opened per person: a row each, today emphasised, amber for an alert today", () => {
    render(<Activity data={activity()} {...props} />);
    const chart = screen.getByRole("list", { name: "Contacts opened, per person" });
    const rory = within(chart).getByRole("listitem", { name: "Rory Reid: 96 contacts in 14 days, 34 today" });
    expect(rory).toHaveTextContent("Sales");
    expect(rory.querySelector("[data-today]")).toHaveAttribute("data-tone", "warn");
    const sam = within(chart).getByRole("listitem", { name: /^Sam Okafor/ });
    expect(sam.querySelector("[data-today]")).toHaveAttribute("data-tone", "accent");
    expect(within(rory).getByRole("link", { name: "96" })).toHaveAttribute(
      "href",
      "/settings/audit?actor=u-rory&action=lead.contact.reveal",
    );
  });

  it("who is signed in now: one row a person, yours marked You, Sign out for the rest", async () => {
    vi.mocked(usersClient.endSessions).mockResolvedValue(ok(null));
    render(<Activity data={activity()} {...props} />);
    const now = screen.getByRole("region", { name: /Signed in now/ });
    expect(now).toHaveTextContent("3 sessions");
    expect(within(now).getByText("You")).toBeInTheDocument();
    // Yours leads the list, whatever the order the sessions came in.
    expect(within(now).getAllByRole("listitem")[0]).toHaveTextContent("Maya Kapoor");
    expect(within(now).getByText(/Chrome on Mac · this session/)).toBeInTheDocument();
    expect(
      within(now).getByText(/Safari on iPhone · since \d{1,2}(:\d{2})? (am|pm) · 2 sessions/),
    ).toBeInTheDocument();
    expect(within(now).queryByRole("button", { name: "Sign out Maya Kapoor" })).not.toBeInTheDocument();
    await userEvent.click(within(now).getByRole("button", { name: "Sign out Sam Okafor" }));
    expect(usersClient.endSessions).toHaveBeenCalledWith("u-sam");
    expect(await within(now).findByText("Signed out")).toBeInTheDocument();
  });

  it("offers Sign out only to someone who manages people, and is calm when nothing happened", () => {
    render(
      <Activity
        data={activity({
          reveals: [],
          today: {
            day: "2026-10-03",
            reveals: { count: 0, people: 0 },
            leadsOpened: { count: 0, usual: 0 },
            exports: { count: 0, by: null },
            failedSignIns: { count: 0, name: null, thenSignedIn: false },
          },
        })}
        timezone="Asia/Dubai"
        canManagePeople={false}
      />,
    );
    expect(screen.queryByRole("button", { name: /^Sign out/ })).not.toBeInTheDocument();
    expect(screen.getByText("Nobody has opened a contact in the last 14 days.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Contacts opened today/ })).toHaveTextContent("nobody yet");
    expect(screen.getByRole("link", { name: /Failed sign-ins today/ })).toHaveTextContent("none");
  });
});
