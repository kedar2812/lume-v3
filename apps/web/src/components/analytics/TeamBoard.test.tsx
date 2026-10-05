import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { analyticsClient, type Team, type TeamRow } from "@/lib/analytics/client";
import { testCatalog } from "@/lib/leads/test-catalog";
import { TeamBoard } from "./TeamBoard";

vi.mock("@/lib/analytics/client", async (orig) => {
  const real = await orig<typeof import("@/lib/analytics/client")>();
  return { ...real, analyticsClient: { teams: vi.fn() } };
});
const ok = <T,>(data: T) => ({ ok: true as const, status: 200, data });

const person = (id: string, name: string, o: Partial<TeamRow> = {}): TeamRow => ({
  id,
  name,
  active: true,
  newLeads: 10,
  assigned: 10,
  contacted: 0.8,
  within1h: 0.5,
  replyRate: 0.4,
  speedToLead: 30,
  held: 2,
  won: 3,
  revenueWon: 3000,
  ontime: 0.9,
  overdueNow: 0,
  previousRank: {},
  previous: { won: 3, revenue: 3000, speed: 30, ontime: 0.9, replies: 0.4 },
  goal: null,
  drill: { cohort: `c-${id}`, won: `w-${id}` },
  ...o,
});
const team = (people: TeamRow[], o: Partial<Team> = {}): Team => ({
  range: { label: "September", days: [] },
  leaderboard: true,
  people,
  discipline: {
    ontime: 0.86,
    previousOntime: 0.82,
    trend: { dir: "up", tone: "good", text: "+4.0 pts" },
    overdueNow: 9,
    people: people.map((p) => ({ id: p.id, ontime: p.ontime, overdueNow: p.overdueNow })),
  },
  ...o,
});
const props = {
  insights: null,
  catalog: testCatalog(),
  compare: true,
  rangeWords: "Last 30 days",
  onDrill: vi.fn(),
};

beforeEach(() => {
  props.onDrill = vi.fn();
  vi.mocked(analyticsClient.teams).mockResolvedValue(
    ok({ teams: [{ id: "t1", name: "Inbound", memberIds: ["riya"] }] }),
  );
});

describe("Team board (canvas Team)", () => {
  const people = [
    person("riya", "Riya Shah", {
      won: 9,
      previous: { won: 6, speed: 40, ontime: 0.9, replies: 0.4, revenue: 1 },
    }),
    person("dev", "Dev Malhotra", { won: 4, speedToLead: 12, overdueNow: 9, ontime: 0.7 }),
    person("hana", "Hana Ito", { won: 6, speedToLead: 55, previous: { won: 0, speed: null } }),
  ];

  it("ranks by wins with each person's change, and their team under their name", async () => {
    render(<TeamBoard team={team(people)} {...props} />);
    const board = screen.getByRole("list", { name: "Leaderboard: Most leads won" });
    const rows = within(board).getAllByRole("button");
    const at = (name: RegExp) => rows.find((r) => name.test(r.getAttribute("aria-label")!))!;
    expect(at(/^1\. Riya Shah: 9/)).toHaveTextContent("+50.0%");
    expect(at(/^2\. Hana Ito: 6/)).toHaveTextContent("New");
    expect(at(/^3\. Dev Malhotra: 4/)).toHaveTextContent("+33.3%");
    expect(await within(at(/Riya/)).findByText("Inbound")).toBeInTheDocument();
    await userEvent.click(at(/Riya/));
    expect(props.onDrill).toHaveBeenCalledWith("w-riya", "Riya Shah: won");
  });

  it("speed ranks the fastest first, and its change is in minutes, fewer being better", async () => {
    render(<TeamBoard team={team(people)} {...props} />);
    await userEvent.click(screen.getByRole("radio", { name: "Speed" }));
    const board = screen.getByRole("list", { name: /Fastest median first contact/ });
    const first = within(board)
      .getAllByRole("button")
      .find((r) => r.getAttribute("aria-label")!.startsWith("1."))!;
    expect(first).toHaveAccessibleName(/^1\. Dev Malhotra: 12 min/);
    expect(first).toHaveTextContent("−18");
  });

  it("revenue is a ranking only for someone who sees money", () => {
    const plain = people.map((p) => {
      const x = { ...p };
      delete x.revenueWon;
      return x;
    });
    render(<TeamBoard team={team(plain)} {...props} />);
    expect(screen.queryByRole("radio", { name: "Revenue" })).not.toBeInTheDocument();
  });

  it("follow-up discipline: the team's ring, each person's on-time and what's overdue now", () => {
    render(<TeamBoard team={team(people)} {...props} />);
    const card = screen.getByRole("region", { name: "Follow-up discipline" });
    expect(card).toHaveTextContent("86%");
    expect(card).toHaveTextContent("+4.0 pts");
    expect(within(card).getByText("Dev Malhotra: 70% on time, 9 overdue now")).toBeInTheDocument();
    expect(within(card).getByText("9 overdue")).toHaveAttribute("data-red");
  });

  it("every person's numbers sort by any heading, and a number opens its leads", async () => {
    render(<TeamBoard team={team(people)} {...props} />);
    const table = screen.getByRole("table");
    const names = () =>
      within(table)
        .getAllByRole("row")
        .slice(1)
        .map((r) => within(r).getByText(/Shah|Malhotra|Ito/).textContent);
    expect(names()).toEqual(["Riya Shah", "Hana Ito", "Dev Malhotra"]);
    await userEvent.click(within(table).getByRole("button", { name: "Speed to lead" }));
    expect(names()).toEqual(["Hana Ito", "Riya Shah", "Dev Malhotra"]);
    await userEvent.click(within(table).getByRole("button", { name: "Speed to lead" }));
    expect(names()).toEqual(["Dev Malhotra", "Riya Shah", "Hana Ito"]);
    await userEvent.click(within(table).getByRole("button", { name: "Hana Ito, won: 6. See the leads." }));
    expect(props.onDrill).toHaveBeenCalledWith("w-hana", "Hana Ito: won");
  });

  it("someone who sees only their own numbers gets no leaderboard", () => {
    render(<TeamBoard team={team([people[0]!], { leaderboard: false })} {...props} />);
    expect(screen.queryByRole("region", { name: "Leaderboard" })).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Each person" })).toHaveTextContent("Your numbers");
  });
});
