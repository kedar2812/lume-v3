import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { IgTotals, InstagramBoard as Data } from "@/lib/analytics/client";
import { InstagramBoard, answerTime } from "./InstagramBoard";

const zero: IgTotals = {
  conversations: 0,
  leads: 0,
  measured: 0,
  inTime: 0,
  ranOut: 0,
  firstAnswerSec: null,
  booked: 0,
  won: 0,
  bookedNew: 0,
  wonNew: 0,
  revenue: 0,
  adClicks: 0,
  privateReplies: 0,
  stopped: 0,
  byStart: { comment: 0, dm: 0, ad: 0, story: 0 },
};
const days = (
  n: number,
  f: (i: number) => Partial<Record<"comment" | "dm" | "ad" | "story", number>> = () => ({}),
) =>
  Array.from({ length: n }, (_, i) => ({
    day: `2026-06-${String(i + 1).padStart(2, "0")}`,
    comment: 0,
    dm: 0,
    ad: 0,
    story: 0,
    ...f(i),
  }));
const data = (o: Partial<Data> = {}): Data => ({
  range: { from: "2026-06-01", to: "2026-06-30", label: "June 1 – 30" },
  totals: zero,
  previous: null,
  rates: { inTime: null, leadRate: null },
  series: days(30),
  funnel: [
    { id: "wrote", n: 0 },
    { id: "lead", n: 0 },
    { id: "booked", n: 0 },
    { id: "won", n: 0 },
  ],
  whoAnswered: [
    { id: "flows", conversations: 0, booked: 0, won: 0, revenue: 0, firstAnswerSec: null },
    { id: "team", conversations: 0, booked: 0, won: 0, revenue: 0, firstAnswerSec: null },
  ],
  accounts: [{ id: "a1", username: "harbour.studio", status: "active", conversations: 0, leads: 0 }],
  sources: [],
  ...o,
});
const busy: IgTotals = {
  conversations: 240,
  leads: 96,
  measured: 200,
  inTime: 170,
  ranOut: 30,
  firstAnswerSec: 42,
  booked: 31,
  won: 9,
  bookedNew: 28,
  wonNew: 8,
  revenue: 81000,
  adClicks: 22,
  privateReplies: 130,
  stopped: 3,
  byStart: { comment: 130, dm: 70, ad: 25, story: 15 },
};
const board = (d: Data | null, compare = true) =>
  render(<InstagramBoard data={d} currency="INR" compare={compare} rangeWords="in the last 30 days" />);
const tile = (label: string) => screen.getByRole("group", { name: new RegExp(`^${label}:`) });

describe("Analytics → Instagram (D6b)", () => {
  it("loading: a placeholder, no numbers", () => {
    const { container } = board(null);
    expect(container.querySelector("[aria-busy='true']")).not.toBeNull();
  });

  it("an empty range: dashes for what can't be said, never 0 sec or NaN, and each part says it's empty", () => {
    board(data());
    expect(
      screen.getByRole("heading", { name: "No conversations on Instagram in the last 30 days." }),
    ).toBeVisible();
    expect(tile("Answered in time")).toHaveTextContent("—");
    expect(tile("First answer \\(median\\)")).toHaveTextContent("—");
    expect(document.body.textContent).not.toMatch(/NaN|Infinity|undefined/);
    expect(screen.getByText("No conversations started in this range yet.")).toBeVisible();
    expect(screen.getByText(/nothing to follow/)).toBeVisible();
    expect(screen.getByText("Nobody has answered a conversation in this range yet.")).toBeVisible();
    expect(screen.getByText("No post or ad started a conversation in this range yet.")).toBeVisible();
  });

  it("its numbers, with the change against the days before; money only for someone who sees it", () => {
    board(
      data({
        totals: busy,
        previous: { ...busy, conversations: 200, stopped: 1, firstAnswerSec: 60, measured: 180, inTime: 160 },
        rates: { inTime: 0.85, leadRate: 0.4 },
      }),
    );
    expect(
      screen.getByRole("heading", { name: "Instagram started 240 conversations in the last 30 days." }),
    ).toBeVisible();
    expect(tile("Conversations")).toHaveTextContent("+20.0%");
    expect(tile("New leads from Instagram")).toHaveTextContent("Made from 40% of conversations");
    expect(tile("Answered in time")).toHaveTextContent("85%");
    expect(tile("First answer \\(median\\)")).toHaveTextContent("42sec");
    expect(tile("Revenue won")).toHaveTextContent("From 9 leads won after a conversation");
    // More asked to stop than before: the tile says so in red, and down is the good way.
    expect(tile("Asked to stop")).toHaveAttribute("data-alarm", "true");
    expect(tile("Conversations")).not.toHaveAttribute("data-alarm");
  });

  it("someone who doesn't see money: no revenue", () => {
    board(data({ totals: { ...busy, revenue: null } }));
    expect(screen.queryByRole("group", { name: /^Revenue won:/ })).toBeNull();
  });

  it("too few answered conversations to say a share", () => {
    board(data({ totals: { ...busy, measured: 4, inTime: 3 }, rates: { inTime: 0.75, leadRate: 0.4 } }));
    expect(tile("Answered in time")).toHaveTextContent("Too few to say yet");
  });

  it("compare off: no changes shown", () => {
    board(data({ totals: busy, previous: { ...busy, conversations: 200 } }), false);
    expect(tile("Conversations")).not.toHaveTextContent("%");
  });

  it("the chart: what started them, each one can be hidden", async () => {
    board(data({ totals: busy, series: days(30, (i) => ({ comment: i % 3, dm: 1, ad: i === 4 ? 2 : 0 })) }));
    const chart = screen.getByRole("region", { name: "Conversations started, by what started them" });
    const comment = within(chart).getByRole("button", { name: "Comment" });
    expect(comment).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(comment);
    expect(comment).toHaveAttribute("aria-pressed", "false");
    expect(within(chart).getByRole("img", { name: /by what started them/ })).toBeVisible();
  });

  it("where people stop, who answered, each account and the posts and ads", () => {
    board(
      data({
        totals: busy,
        funnel: [
          { id: "wrote", n: 240 },
          { id: "lead", n: 96 },
          { id: "booked", n: 31 },
          { id: "won", n: 9 },
        ],
        whoAnswered: [
          { id: "flows", conversations: 150, booked: 20, won: 6, revenue: 54000, firstAnswerSec: 3 },
          { id: "team", conversations: 80, booked: 11, won: 3, revenue: 27000, firstAnswerSec: 1080 },
        ],
        accounts: [
          { id: "a1", username: "harbour.studio", status: "active", conversations: 200, leads: 80 },
          { id: "a2", username: "maya.coach", status: "needs_attention", conversations: 40, leads: 16 },
        ],
        sources: [
          { kind: "ad", id: "120200000000001", conversations: 25, leads: 12 },
          { kind: "reels", id: "17980000000000001", conversations: 60, leads: 10 },
        ],
      }),
    );
    const steps = screen.getByRole("region", { name: "Where people stop" });
    expect(steps).toHaveTextContent("Became a lead96");
    expect(steps).toHaveTextContent("Won9");
    const who = screen.getByRole("region", { name: "Who answered" });
    expect(who).toHaveTextContent(/Flows150 conversations20 booked6 won · ₹54(K|,000)3 sec first answer/);
    expect(who).toHaveTextContent(/Your team80 conversations11 booked3 won · ₹27(K|,000)18 min first answer/);
    expect(who).not.toHaveTextContent("LUME AI");
    const accounts = screen.getByRole("region", { name: "Each account" });
    expect(accounts).toHaveTextContent("@maya.coachNeeds connecting again: messages wait meanwhile");
    const src = screen.getByRole("region", { name: "The posts and ads that started them" });
    expect(src).toHaveTextContent("Ad120200000000001");
    expect(src).toHaveTextContent("Reel17980000000000001");
  });

  it("how long an answer took, in words", () => {
    expect(answerTime(null)).toEqual({ v: "—" });
    expect(answerTime(3)).toEqual({ v: "3", unit: "sec" });
    expect(answerTime(59.6)).toEqual({ v: "1", unit: "min" });
    expect(answerTime(2 * 3600)).toEqual({ v: "2", unit: "h" });
    expect(answerTime(1080)).toEqual({ v: "18", unit: "min" });
    expect(answerTime(3 * 86400)).toEqual({ v: "3", unit: "days" });
  });
});
