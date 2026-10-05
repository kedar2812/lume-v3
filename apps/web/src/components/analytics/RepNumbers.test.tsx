import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { trend } from "@lume/core/shared";
import type { Me } from "@/lib/analytics/client";
import { RepNumbers } from "./RepNumbers";

const NOW = new Date("2026-10-05T06:00:00Z"); // 11:30 am in Kolkata
const me = (o: Partial<Me> = {}): Me => ({
  range: { label: "October 1 – 5", days: [] },
  heroLine: "",
  goals: [
    { metric: "won", target: 20, value: 9, pace: null },
    { metric: "calls_held", target: 40, value: 40, pace: null },
  ],
  tiles: [
    { id: "new_leads", value: 118, previous: 104, trend: trend(118, 104) },
    { id: "reply_rate", value: 0.46, previous: 0.43, trend: trend(0.46, 0.43, { kind: "pts" }) },
    { id: "won", value: 9, previous: 7, trend: trend(9, 7) },
    { id: "speed_to_lead", value: 9, previous: 12, trend: trend(9, 12, { kind: "abs", good: "down" }) },
  ],
  followUps: {
    dueNow: 0,
    ontime: 0.96,
    next: [
      { id: "t1", leadId: "l1", leadName: "Kenji Sato", title: "Call back", dueAt: "2026-10-05T07:00:00Z" },
      { id: "t2", leadId: "l2", leadName: "Amara Obi", title: "Check in", dueAt: "2026-10-06T05:00:00Z" },
      { id: "t3", leadId: "l3", leadName: "Tamara Novak", title: "Price", dueAt: "2026-10-08T05:00:00Z" },
    ],
  },
  funnel: {
    stages: [
      { id: "s1", name: "New", share: 1 },
      { id: "s2", name: "Won", share: 0.076 },
    ],
    myWinRate: 0.076,
    businessWinRate: 0.061,
  },
  replyDays: [1, 2, 3, 4, 5, 6, 0].map((dow) => ({
    dow,
    sends: 40,
    rate: dow === 2 ? 0.58 : dow === 6 ? 0.22 : 0.4,
    tooFew: false,
  })),
  ...o,
});
const props = {
  currency: "AED",
  timezone: "Asia/Kolkata",
  compare: true,
  rangeWords: "in October",
  now: NOW,
};

describe("a rep's own numbers (canvas Rep)", () => {
  it("the month so far: what moved, the follow-ups, and each goal as a ring", () => {
    render(<RepNumbers me={me()} {...props} />);
    const hero = screen.getByRole("region", { name: /^Your \w+, so far$/ });
    expect(hero).toHaveTextContent("You’re ahead of the period before on new leads, replies, wins and speed");
    expect(hero).toHaveTextContent("Every follow-up is on time.");
    expect(hero).toHaveTextContent("9of 20Won");
    expect(hero).toHaveTextContent("40of 40Calls held");
  });

  it("follow-ups due now and next, in the owner's date style, each opening its lead", () => {
    render(<RepNumbers me={me()} {...props} />);
    const card = screen.getByRole("region", { name: "Your follow-ups" });
    expect(card).toHaveTextContent("96% on time");
    const links = within(card).getAllByRole("link");
    expect(links[0]).toHaveTextContent("Kenji SatoCall backDue 12:30 pm");
    expect(links[0]).toHaveAttribute("href", "/leads?lead=l1");
    expect(links[1]).toHaveTextContent("Tomorrow");
    expect(links[2]).toHaveTextContent("October 8, Thursday");
  });

  it("their funnel beside the business's win rate, and their best and worst reply days", () => {
    render(<RepNumbers me={me()} {...props} />);
    expect(screen.getByRole("region", { name: "Your funnel" })).toHaveTextContent(
      "Your win rate 7.6%The business’s 6.1%",
    );
    const reply = screen.getByRole("region", { name: "When your leads reply" });
    expect(reply).toHaveTextContent("Your Tuesdays are your best");
    expect(reply).toHaveTextContent("58% of your Tuesday messages got a reply. Saturdays, 22%.");
  });

  it("no goals, no rings; too few messages, no day claims", () => {
    render(
      <RepNumbers
        me={me({ goals: [], replyDays: me().replyDays.map((d) => ({ ...d, tooFew: true })) })}
        {...props}
      />,
    );
    expect(screen.queryByText(/of 20/)).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "When your leads reply" })).toHaveTextContent(
      "Too few messages",
    );
  });
});
