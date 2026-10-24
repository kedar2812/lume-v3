import { describe, expect, it } from "vitest";
import type { RunDetail, RunLead } from "./types";
import { currentLead, runCounts, runStatus, whenWords } from "./words";

const lead = (o: Partial<RunLead> & { leadId: string }): RunLead => ({
  name: "Lead",
  state: "up_next",
  reason: null,
  card: null,
  thought: null,
  repliedAt: null,
  draft: null,
  nextAt: null,
  lastSentAt: null,
  updatedAt: "2026-10-26T09:00:00.000Z",
  ...o,
});
const detail = (o: {
  status?: "running" | "paused" | "ended";
  pauseReason?: string | null;
  leads?: RunLead[];
}) =>
  ({
    run: { id: "r1", status: o.status ?? "running", pauseReason: o.pauseReason ?? null, canControl: true },
    counts: {},
    leads: o.leads ?? [],
    asks: [],
  }) as unknown as RunDetail;

const NOW = new Date("2026-10-26T09:00:00.000Z");
const when = (iso: string) => `at ${iso.slice(11, 16)}`;
const status = (d: RunDetail) => runStatus(d, NOW, when);

/** What the run bar says (Autopilot A3, Review Focus 5): every state in words, never a mark drawing forever. */
describe("runStatus", () => {
  it("working while it writes or has someone to message", () => {
    expect(status(detail({ leads: [lead({ leadId: "a", state: "writing" })] }))).toEqual({
      title: "LUME AI is working",
      line: null,
      working: true,
    });
    expect(status(detail({ leads: [lead({ leadId: "a", state: "up_next" })] })).working).toBe(true);
  });

  it("someone to message, but not yet (hours, pacing): when the next one goes, not a mark drawing all night", () => {
    const s = status(
      detail({ leads: [lead({ leadId: "a", state: "up_next", nextAt: "2026-10-27T04:30:00.000Z" })] }),
    );
    expect(s).toEqual({
      title: "Waiting to send the next message",
      line: "Next one at 04:30",
      working: false,
    });
    expect(
      status(detail({ leads: [lead({ leadId: "a", state: "up_next", nextAt: "2026-10-26T08:59:00.000Z" })] }))
        .working,
    ).toBe(true);
  });

  it("waiting for replies says when the next follow-up goes; one due now is work", () => {
    expect(
      status(detail({ leads: [lead({ leadId: "a", state: "sent", nextAt: "2026-10-28T04:30:00.000Z" })] })),
    ).toEqual({ title: "Waiting for replies", line: "Next follow-up at 04:30", working: false });
    expect(
      status(detail({ leads: [lead({ leadId: "a", state: "sent", nextAt: "2026-10-26T08:00:00.000Z" })] }))
        .working,
    ).toBe(true);
  });

  it("waiting for replies when everyone's been messaged and nothing is due", () => {
    const s = status(
      detail({ leads: [lead({ leadId: "a", state: "sent" }), lead({ leadId: "b", state: "talking" })] }),
    );
    expect(s).toEqual({
      title: "Waiting for replies",
      line: "LUME AI follows up on the days you chose.",
      working: false,
    });
  });

  it("waiting on you when only people's leads are left", () => {
    expect(
      status(
        detail({ leads: [lead({ leadId: "a", state: "ready" }), lead({ leadId: "b", state: "stopped" })] }),
      ),
    ).toEqual({
      title: "Waiting on you",
      line: "The leads left are ready for you or with you.",
      working: false,
    });
  });

  it("each pause says why, and what happens next", () => {
    const paused = (r: string) => status(detail({ status: "paused", pauseReason: r }));
    expect(paused("person")).toEqual({
      title: "Paused",
      line: "Nothing is sent until you resume.",
      working: false,
    });
    expect(paused("month").title).toBe("Paused: this month's LUME AI is used");
    expect(paused("month").line).toBe("It carries on by itself once a top-up is added.");
    expect(paused("quality").title).toBe("Paused to protect your WhatsApp number");
    expect(paused("speaker").title).toBe("Paused: the person it speaks as can't send messages now");
    expect(paused("number").title).toBe("Paused: the WhatsApp number isn't connected");
    expect(paused("paid").title).toBe("Paused: this month's paid WhatsApp messages are used");
    for (const r of ["person", "month", "quality", "speaker", "number", "paid"])
      expect(paused(r).working).toBe(false);
  });

  it("done, with what it did", () => {
    expect(
      status(
        detail({
          status: "ended",
          leads: [
            lead({ leadId: "a", state: "ready", lastSentAt: "2026-10-26T09:00:00.000Z" }),
            lead({ leadId: "b", state: "sent", lastSentAt: "2026-10-26T09:00:00.000Z" }),
          ],
        }),
      ),
    ).toEqual({ title: "Done", line: "2 messaged · 1 ready for you", working: false });
  });
});

describe("runCounts", () => {
  it("messaged, replied, ready for you and stopped, from what really happened", () => {
    const c = runCounts(
      detail({
        leads: [
          lead({ leadId: "a", state: "talking", lastSentAt: "t", repliedAt: "t" }),
          lead({ leadId: "b", state: "needs_you", lastSentAt: "t", repliedAt: "t" }),
          lead({ leadId: "c", state: "ready", lastSentAt: "t", repliedAt: "t" }),
          lead({ leadId: "d", state: "stopped", lastSentAt: "t", repliedAt: "t" }),
          lead({ leadId: "e", state: "sent", lastSentAt: "t" }),
          lead({ leadId: "f", state: "up_next" }),
          lead({ leadId: "g", state: "skipped", reason: "No WhatsApp number" }),
        ],
      }),
    );
    expect(c).toEqual({ messaged: 5, replied: 4, ready: 2, stopped: 1, inRun: 6, done: 5 / 6 });
  });

  it("an empty run is nothing done, never a division by zero", () => {
    expect(runCounts(detail({ leads: [] }))).toEqual({
      messaged: 0,
      replied: 0,
      ready: 0,
      stopped: 0,
      inRun: 0,
      done: 0,
    });
  });
});

describe("currentLead", () => {
  it("the one being written to; else the most recent LUME AI is working; else none", () => {
    const a = lead({ leadId: "a", state: "sent", updatedAt: "2026-10-26T09:05:00.000Z" });
    const b = lead({ leadId: "b", state: "writing", updatedAt: "2026-10-26T09:01:00.000Z" });
    const c = lead({ leadId: "c", state: "talking", updatedAt: "2026-10-26T09:09:00.000Z" });
    expect(currentLead(detail({ leads: [a, b, c] }))?.leadId).toBe("b");
    expect(currentLead(detail({ leads: [a, c] }))?.leadId).toBe("c");
    expect(currentLead(detail({ leads: [lead({ leadId: "d", state: "ready" })] }))).toBeNull();
  });
});

describe("whenWords", () => {
  const now = new Date("2026-10-26T05:00:00.000Z"); // 10:30 am in Kolkata, a Monday
  it("today, tomorrow, then the date, on the business's clock", () => {
    // LUME's own way with times: "2 pm", "10:30 am".
    expect(whenWords("2026-10-26T08:30:00.000Z", "Asia/Kolkata", now)).toBe("at 2 pm");
    expect(whenWords("2026-10-27T05:00:00.000Z", "Asia/Kolkata", now)).toBe("tomorrow at 10:30 am");
    expect(whenWords("2026-10-29T04:30:00.000Z", "Asia/Kolkata", now)).toMatch(/^on October 29.* at 10 am$/);
  });
});
