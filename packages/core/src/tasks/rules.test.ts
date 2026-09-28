import { describe, expect, it } from "vitest";
import {
  DEFAULT_WORKING_HOURS,
  describePreset,
  describeRule,
  duePresetsSchema,
  onEnterSchema,
  workingHoursSchema,
  type StageRule,
} from "./rules";
import { DEFAULT_DUE_PRESETS } from "./time";

const ok = (s: { safeParse: (v: unknown) => { success: boolean } }, v: unknown) => s.safeParse(v).success;

describe("working hours (3C)", () => {
  it("defaults to Monday to Friday, 09:00 to 18:00", () => {
    expect(DEFAULT_WORKING_HOURS).toEqual({ days: [1, 2, 3, 4, 5], start: "09:00", end: "18:00" });
    expect(ok(workingHoursSchema, DEFAULT_WORKING_HOURS)).toBe(true);
  });
  it("refuses no days, repeated days, and a day that ends before it starts", () => {
    expect(ok(workingHoursSchema, { days: [], start: "09:00", end: "18:00" })).toBe(false);
    expect(ok(workingHoursSchema, { days: [1, 1], start: "09:00", end: "18:00" })).toBe(false);
    expect(ok(workingHoursSchema, { days: [7], start: "09:00", end: "18:00" })).toBe(false);
    expect(ok(workingHoursSchema, { days: [1], start: "18:00", end: "18:00" })).toBe(false);
    expect(ok(workingHoursSchema, { days: [1], start: "9:00", end: "18:00" })).toBe(false);
  });
});

describe("time choices (3C)", () => {
  it("the defaults are valid", () => {
    expect(ok(duePresetsSchema, DEFAULT_DUE_PRESETS)).toBe(true);
  });
  it("refuses none, more than eight, repeated ids, and odd values", () => {
    const one = { id: "in_30m", label: "In 30 minutes", rule: { in: { n: 30, unit: "minute" } } };
    expect(ok(duePresetsSchema, [])).toBe(false);
    expect(
      ok(
        duePresetsSchema,
        Array.from({ length: 9 }, (_, i) => ({ ...one, id: `p${i}` })),
      ),
    ).toBe(false);
    expect(ok(duePresetsSchema, [one, one])).toBe(false);
    expect(ok(duePresetsSchema, [{ ...one, id: "In 30" }])).toBe(false);
    expect(ok(duePresetsSchema, [{ ...one, label: "" }])).toBe(false);
    expect(ok(duePresetsSchema, [{ ...one, rule: { in: { n: 0, unit: "minute" } } }])).toBe(false);
    expect(ok(duePresetsSchema, [{ ...one, rule: { at: { days: 31, time: "10:00" } } }])).toBe(false);
    expect(ok(duePresetsSchema, [{ ...one, rule: { weekday: { day: 7, time: "10:00" } } }])).toBe(false);
  });
  it("reads as people say them", () => {
    const d = (rule: unknown) => describePreset({ id: "x", label: "x", rule } as never);
    expect(d({ in: { n: 30, unit: "minute" } })).toBe("in 30 minutes");
    expect(d({ in: { n: 1, unit: "hour" } })).toBe("in 1 hour");
    expect(d({ in: { n: 2, unit: "day" } })).toBe("in 2 days");
    expect(d({ at: { days: 0, time: "17:00" } })).toBe("today at 17:00");
    expect(d({ at: { days: 1, time: "10:00" } })).toBe("tomorrow at 10:00");
    expect(d({ at: { days: 3, time: "09:30" } })).toBe("in 3 days at 09:30");
    expect(d({ weekday: { day: 1, time: "10:00" } })).toBe("next Monday at 10:00");
  });
});

describe("stage rules (3C)", () => {
  const task: StageRule = {
    id: "0192f0a0-0000-7000-8000-000000000001",
    type: "create_task",
    title: "Send the plan",
    dueIn: { n: 2, unit: "day" },
    assignee: "lead_owner",
  };
  const user = "0192f0a0-0000-7000-8000-0000000000aa";
  it("accepts up to five rules, each kind", () => {
    expect(ok(onEnterSchema, { rules: [] })).toBe(true);
    expect(
      ok(onEnterSchema, {
        rules: [
          task,
          { id: "0192f0a0-0000-7000-8000-000000000002", type: "cancel_open_tasks" },
          {
            id: "0192f0a0-0000-7000-8000-000000000003",
            type: "notify",
            to: ["lead_owner", { userId: user }],
          },
        ],
      }),
    ).toBe(true);
  });
  it("refuses six rules, repeated ids, an empty title, a zero wait, and telling nobody", () => {
    const six = Array.from({ length: 6 }, (_, i) => ({
      ...task,
      id: `0192f0a0-0000-7000-8000-00000000001${i}`,
    }));
    expect(ok(onEnterSchema, { rules: six })).toBe(false);
    expect(ok(onEnterSchema, { rules: [task, task] })).toBe(false);
    expect(ok(onEnterSchema, { rules: [{ ...task, title: " " }] })).toBe(false);
    expect(ok(onEnterSchema, { rules: [{ ...task, dueIn: { n: 0, unit: "day" } }] })).toBe(false);
    expect(ok(onEnterSchema, { rules: [{ id: task.id, type: "notify", to: [] }] })).toBe(false);
  });
  it("each rule in one plain sentence", () => {
    const names = new Map([[user, "Riya Shah"]]);
    expect(describeRule(task, names)).toBe("Sets a follow-up for the lead's owner in 2 days: Send the plan");
    expect(describeRule({ ...task, dueIn: { n: 1, unit: "hour" }, assignee: { userId: user } }, names)).toBe(
      "Sets a follow-up for Riya Shah in 1 hour: Send the plan",
    );
    expect(describeRule({ id: task.id, type: "cancel_open_tasks" }, names)).toBe(
      "Clears the lead's open follow-ups",
    );
    expect(describeRule({ id: task.id, type: "notify", to: ["lead_owner", { userId: user }] }, names)).toBe(
      "Tells the lead's owner and Riya Shah",
    );
    expect(describeRule({ id: task.id, type: "notify", to: [{ userId: "gone" }] }, names)).toBe(
      "Tells someone who's no longer here",
    );
  });
});
