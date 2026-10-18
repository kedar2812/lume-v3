// @vitest-environment jsdom
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/lib/client";
import { AnnouncementSheet } from "./AnnouncementSheet";
import { FleetScreen, type Announcement, type FleetRow } from "./FleetScreen";
import { HealthCard } from "./HealthCard";

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
const replace = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace }),
  usePathname: () => "/fleet",
}));

const ok = <T,>(data: T) => ({ ok: true as const, data });
const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
const row = (over: Partial<FleetRow>): FleetRow => ({
  id: "c1",
  name: "Brightpath Studio",
  status: "ok",
  problems: [],
  lastCheckInAt: hoursAgo(2),
  version: "1.5.0",
  behind: false,
  people: 2,
  leads: 120,
  dbBytes: 96_000_000,
  diskFreePct: 71,
  acceptsAnnouncements: true,
  ...over,
});
const fleet = {
  rows: [
    row({ id: "c2", name: "Harbour Clinic", status: "down", lastCheckInAt: hoursAgo(31) }),
    row({
      id: "c3",
      name: "Kestrel Logistics",
      status: "look",
      diskFreePct: 4,
      dbBytes: 1_900_000_000,
      problems: [
        {
          key: "disk",
          severity: "red",
          short: "Disk almost full",
          words: "The server’s disk is almost full: 4% free.",
        },
        { key: "jobs_failed", severity: "amber", short: "Jobs failing", words: "3 background jobs failed." },
      ],
    }),
    row({
      id: "c4",
      name: "Oakline <b>Realty</b>",
      status: "none",
      version: "1.3.8",
      behind: true,
      dbBytes: null,
      diskFreePct: null,
    }),
    row({}),
  ],
  latestVersion: "1.5.0",
  counts: { total: 4, online: 3, look: 1, down: 1, none: 1, behind: 1 },
};
const announcement = (over: Partial<Announcement> = {}): Announcement => ({
  id: "a1",
  title: "LUME will be updated on Saturday night",
  body: "LUME will be away for about 30 minutes.",
  kind: "maintenance",
  windowStart: "2026-10-18T16:30:00.000Z",
  windowEnd: "2026-10-18T17:00:00.000Z",
  audienceText: "Admins at all clients",
  startsAt: hoursAgo(5),
  endsAt: "2026-10-19T00:00:00.000Z",
  withdrawnAt: null,
  state: "live",
  reach: { audience: 4, reached: 2, cannot: 1, waiting: 1, seenBy: 9 },
  clients: [
    { id: "c1", name: "Brightpath Studio", reach: "reached" },
    { id: "c4", name: "Oakline Realty", reach: "older" },
  ],
  ...over,
});

beforeEach(() => {
  vi.mocked(api.get).mockReset();
  vi.mocked(api.post).mockReset();
  vi.mocked(api.get).mockImplementation(async (path: string) => {
    if (path === "/api/fleet") return ok(fleet) as never;
    if (path === "/api/announcements")
      return ok({
        announcements: [
          announcement(),
          announcement({
            id: "a2",
            title: "Calendar sync paused",
            kind: "update",
            windowStart: null,
            windowEnd: null,
            state: "withdrawn",
          }),
        ],
      }) as never;
    if (path.startsWith("/api/alerts")) return ok({ alerts: [] }) as never;
    return { ok: false, status: 404, message: "Nothing here." } as never;
  });
});

describe("Fleet · Health", () => {
  it("shows the tiles, every LUME worst first with its problems, and the disk in colour", async () => {
    render(<FleetScreen />);
    const list = await screen.findByRole("region", { name: "Every client's LUME" });
    await within(list).findByText("Kestrel Logistics");
    expect(screen.getByText("3 of 4")).toBeInTheDocument();
    const names = within(list)
      .getAllByRole("link")
      .map((a) => a.querySelector(".fl-name")!.textContent);
    expect(names).toEqual([
      "Harbour Clinic",
      "Kestrel Logistics",
      "Oakline <b>Realty</b>",
      "Brightpath Studio",
    ]);
    const kestrel = within(list).getByText("Kestrel Logistics").closest("a")!;
    expect(within(kestrel).getByText("Disk almost full")).toHaveClass("fl-chip", "fl-red");
    expect(within(kestrel).getByText("4%")).toHaveClass("fl-red-text");
    expect(within(kestrel).getByText("1.9 GB")).toBeInTheDocument();
    expect(within(list).getByText("Health arrives once it’s updated")).toBeInTheDocument();
    expect(within(list).getByText("update")).toBeInTheDocument();
  });

  it("shows people against places where a client's plan has a limit (spec 2026-10-17 control §3.3)", async () => {
    vi.mocked(api.get).mockImplementation(async (path: string) => {
      if (path === "/api/fleet") return ok({ ...fleet, rows: [row({ people: 4, places: 5 })] }) as never;
      return ok({ alerts: [] }) as never;
    });
    render(<FleetScreen />);
    expect(await screen.findByText("4 of 5")).toBeInTheDocument();
  });

  it("narrows to a status from the filter or a tile, and says when there's none", async () => {
    const user = userEvent.setup();
    render(<FleetScreen />);
    const list = await screen.findByRole("region", { name: "Every client's LUME" });
    await within(list).findByText("Kestrel Logistics");
    await user.click(
      within(screen.getByRole("group", { name: "Status" })).getByRole("button", { name: /^Down/ }),
    );
    expect(within(list).getAllByRole("link")).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: /Problems their LUME reported/ }));
    expect(within(list).getByText("Kestrel Logistics")).toBeInTheDocument();
    expect(within(list).getAllByRole("link")).toHaveLength(1);
    await user.type(screen.getByRole("searchbox", { name: "Search clients" }), "zzz");
    expect(within(list).getByText("No client by that name.", { exact: false })).toBeInTheDocument();
  });
});

describe("Fleet · Announcements", () => {
  it("lists them with how far each got, opens one to its clients, and asks before withdrawing", async () => {
    const user = userEvent.setup();
    vi.mocked(api.post).mockResolvedValue(ok({}) as never);
    render(<FleetScreen initialTab="announcements" />);
    const head = await screen.findByRole("button", { name: /LUME will be updated on Saturday night/ });
    expect(head).toHaveTextContent("Reached 2 of 4 · 1 on an older LUME · seen by 9 people");
    expect(screen.getByText("Withdrawn")).toBeInTheDocument();
    await user.click(head);
    expect(screen.getByText("Older LUME")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Withdraw…" }));
    expect(screen.getByText("It leaves each LUME at its next check-in, within 6 hours.")).toBeInTheDocument();
    expect(api.post).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Withdraw" }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith("/api/announcements/a1/withdraw"));
  });
});

describe("New announcement", () => {
  it("waits for a title and a message, asks a maintenance for its window, previews it, and publishes exactly that", async () => {
    const user = userEvent.setup();
    const onPublished = vi.fn();
    vi.mocked(api.post).mockResolvedValue(ok({}) as never);
    render(
      <AnnouncementSheet
        clients={[
          { id: "c1", name: "Brightpath Studio" },
          { id: "c2", name: "Harbour Clinic" },
        ]}
        onClose={vi.fn()}
        onPublished={onPublished}
      />,
    );
    const publish = screen.getByRole("button", { name: "Publish" });
    expect(publish).toBeDisabled();
    await user.type(screen.getByLabelText("Title"), "Snooze by an hour <now>");
    await user.type(screen.getByLabelText("Message"), "Open a reminder and choose Snooze.");
    expect(publish).toBeEnabled();
    expect(screen.getAllByText("Snooze by an hour <now>")).toHaveLength(2); // Porcelain and Obsidian, as text
    await user.click(screen.getByRole("radio", { name: "Maintenance" }));
    expect(publish).toBeDisabled();
    await user.click(screen.getByRole("radio", { name: "Update" }));
    await user.click(screen.getByRole("radio", { name: "Admins only" }));
    await user.click(screen.getByRole("radio", { name: "Choose…" }));
    expect(publish).toBeDisabled();
    await user.click(screen.getByRole("checkbox", { name: "Harbour Clinic" }));
    await user.click(publish);
    await waitFor(() => expect(onPublished).toHaveBeenCalled());
    expect(api.post).toHaveBeenCalledWith(
      "/api/announcements",
      expect.objectContaining({
        title: "Snooze by an hour <now>",
        body: "Open a reminder and choose Snooze.",
        kind: "update",
        windowStart: null,
        audience: "admins",
        clients: ["c2"],
        startsAt: null,
      }),
    );
  });

  it("says why the server refused, and keeps everything", async () => {
    const user = userEvent.setup();
    vi.mocked(api.post).mockResolvedValue({
      ok: false,
      status: 400,
      message: "An announcement shows for 60 days at most.",
    } as never);
    render(<AnnouncementSheet clients={[]} onClose={vi.fn()} onPublished={vi.fn()} />);
    await user.type(screen.getByLabelText("Title"), "Hello");
    await user.type(screen.getByLabelText("Message"), "Words.");
    await user.click(screen.getByRole("button", { name: "Publish" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("An announcement shows for 60 days at most.");
    expect(screen.getByLabelText("Title")).toHaveValue("Hello");
  });
});

describe("a client's Health card", () => {
  it("on an older LUME says when health arrives", () => {
    render(
      <HealthCard
        data={{ health: { status: "none", problems: [], health: null, at: hoursAgo(5) }, healthTrend: [] }}
        version="1.3.8"
      />,
    );
    expect(
      screen.getByText(/This LUME runs 1\.3\.8\. Health arrives once this LUME is updated\./),
    ).toBeInTheDocument();
  });
  it("shows the problems in words and the trend", () => {
    render(
      <HealthCard
        data={{
          health: {
            status: "look",
            problems: [
              {
                key: "disk",
                severity: "red",
                short: "Disk almost full",
                words: "The server’s disk is almost full: 4% free.",
              },
            ],
            health: {
              uptimeS: 1_036_800,
              dbBytes: 1_900_000_000,
              diskFreePct: 4,
              errors24h: 2,
              queue: { waiting: 4, retrying: 0, failed24h: 3 },
              remindersLate: 0,
              restoreTest: { at: "2026-10-14T03:15:00.000Z", ok: true },
              problems: ["jobs_failed"],
              sourcesNeedingAttention: 0,
            },
            at: hoursAgo(6),
          },
          healthTrend: [
            { day: "2026-10-14", dbBytes: 1_700_000_000, diskFreePct: 9 },
            { day: "2026-10-15", dbBytes: 1_900_000_000, diskFreePct: 4 },
          ],
        }}
        version="1.5.0"
      />,
    );
    expect(screen.getByText("The server’s disk is almost full: 4% free.")).toHaveClass("fl-red");
    expect(screen.getByText("12 days")).toBeInTheDocument();
    expect(screen.getByText("4 waiting · 3 failed")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: /Disk free over 2 days, from 9% to 4%/ })).toBeInTheDocument();
  });
});

describe("dates on the Announcements list (final review)", () => {
  it("a night window shows the owner's own day, not the UTC one", async () => {
    const tz = process.env.TZ;
    process.env.TZ = "Asia/Kolkata";
    try {
      vi.mocked(api.get).mockImplementation(async (path: string) => {
        if (path === "/api/fleet") return ok(fleet) as never;
        if (path === "/api/announcements")
          return ok({
            announcements: [
              announcement({
                windowStart: "2026-10-18T19:00:00.000Z",
                windowEnd: "2026-10-18T19:30:00.000Z",
                endsAt: "2026-10-19T20:00:00.000Z",
              }),
            ],
          }) as never;
        return ok({ alerts: [] }) as never;
      });
      render(<FleetScreen initialTab="announcements" />);
      const head = await screen.findByRole("button", { name: /LUME will be updated/ });
      expect(head).toHaveTextContent("Oct 19, 12:30 am – 1:00 am");
      expect(head).toHaveTextContent("until Oct 20");
    } finally {
      process.env.TZ = tz;
    }
  });
});
