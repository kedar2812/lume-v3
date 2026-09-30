import { describe, expect, it } from "vitest";
import { alertsFor, visibleAlerts, type AlertClient } from "./alerts";

const now = new Date("2026-09-29T12:00:00Z");
const base: AlertClient = {
  id: "c1",
  name: "Harbour Clinic",
  type: "subscription",
  paidUntil: "2026-10-20",
  trialEnds: null,
  suspended: false,
  decommissioned: false,
  lastCheckInAt: "2026-09-29T10:00:00Z",
  version: "1.4.2",
  price: { currency: "INR", amount: 2999, periodMonths: 1 },
  monthlyInr: 2999,
};
const ids = (cs: AlertClient[], latest = "1.4.2") =>
  alertsFor(cs, { now, latestVersion: latest }).map((a) => a.id);

describe("the bell: what needs a look (spec §4.4)", () => {
  it("all quiet is no alerts", () => {
    expect(ids([base])).toEqual([]);
  });
  it("a late payment, red, saying how late and how much", () => {
    const a = alertsFor([{ ...base, paidUntil: "2026-09-26" }], { now, latestVersion: "1.4.2" });
    expect(a).toEqual([
      expect.objectContaining({
        id: "late:c1",
        tone: "red",
        title: "Harbour Clinic's payment is 3 days late",
        body: "₹2,999 was due on 26 Sep. Send a reminder and they see it at every sign-in until it's paid.",
        clientId: "c1",
      }),
    ]);
    expect(alertsFor([{ ...base, paidUntil: "2026-09-28" }], { now, latestVersion: "1.4.2" })[0]!.title).toBe(
      "Harbour Clinic's payment is 1 day late",
    );
  });
  it("no check-in for over 24 hours, amber; never for a client that hasn't installed yet or is suspended", () => {
    expect(ids([{ ...base, lastCheckInAt: "2026-09-28T11:00:00Z" }])).toEqual(["quiet:c1"]);
    expect(ids([{ ...base, lastCheckInAt: "2026-09-28T12:30:00Z" }])).toEqual([]);
    expect(ids([{ ...base, lastCheckInAt: null }])).toEqual([]);
    expect(ids([{ ...base, lastCheckInAt: "2026-09-20T11:00:00Z", suspended: true }])).toEqual([]);
  });
  it("due within 5 days, blue; a trial ending within 15 days, violet", () => {
    expect(ids([{ ...base, paidUntil: "2026-10-03" }])).toEqual(["due:c1"]);
    expect(ids([{ ...base, paidUntil: "2026-10-05" }])).toEqual([]);
    expect(ids([{ ...base, type: "trial", paidUntil: null, trialEnds: "2026-10-14" }])).toEqual(["trial:c1"]);
    expect(ids([{ ...base, type: "trial", paidUntil: null, trialEnds: "2026-10-15" }])).toEqual([]);
  });
  it("installations on an older version, one grey alert naming them", () => {
    const a = alertsFor(
      [
        { ...base, id: "a", name: "Oakline Realty", version: "1.3.8" },
        { ...base, id: "b", name: "Kestrel Logistics", version: "1.3.8" },
        { ...base, id: "c", name: "Lotus", version: "1.10.0" },
      ],
      { now, latestVersion: "1.10.0" },
    );
    expect(a).toEqual([
      expect.objectContaining({
        id: "old",
        tone: "grey",
        title: "2 installations are on an older version",
        body: "Oakline Realty and Kestrel Logistics. 1.10.0 is out.",
      }),
    ]);
  });
  it("a hidden alert comes back when its condition changes", () => {
    const late = alertsFor([{ ...base, paidUntil: "2026-09-26" }], { now, latestVersion: "1.4.2" });
    const hidden = new Map(late.map((a) => [a.id, a.fingerprint]));
    expect(visibleAlerts(late, hidden)).toEqual([]);
    // Paid, then late again: a new late payment.
    const again = alertsFor([{ ...base, paidUntil: "2026-10-26", lastCheckInAt: "2026-10-29T10:00:00Z" }], {
      now: new Date("2026-10-29T12:00:00Z"),
      latestVersion: "1.4.2",
    });
    expect(visibleAlerts(again, hidden).map((a) => a.id)).toEqual(["late:c1"]);
    // A newer version out: the old-version alert returns.
    const old1 = alertsFor([{ ...base, version: "1.3.8" }], { now, latestVersion: "1.4.2" });
    const hid = new Map(old1.map((a) => [a.id, a.fingerprint]));
    const old2 = alertsFor([{ ...base, version: "1.3.8" }], { now, latestVersion: "1.5.0" });
    expect(visibleAlerts(old2, hid).map((a) => a.id)).toEqual(["old"]);
  });
  it("the most urgent first: late, quiet, due, trial, old", () => {
    expect(
      ids([
        { ...base, id: "t", type: "trial", paidUntil: null, trialEnds: "2026-10-01" },
        { ...base, id: "d", paidUntil: "2026-10-01" },
        { ...base, id: "l", paidUntil: "2026-09-20", lastCheckInAt: "2026-09-27T00:00:00Z" },
        { ...base, id: "o", version: "1.0.0" },
      ]),
    ).toEqual(["late:l", "quiet:l", "due:d", "trial:t", "old"]);
  });
});
