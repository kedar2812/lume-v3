/**
 * What an admin can set up around follow-ups (Phase 3C; report §10.2, §10.5): the business's working
 * hours, the due-time choices people pick from, and what a stage does when a lead enters it. Shared with
 * the web, so a form refuses in LUME's words before the server is asked.
 */
import { z } from "zod";
import type { DuePresetDef, WorkingHours } from "./time";

export const DEFAULT_WORKING_HOURS: WorkingHours = { days: [1, 2, 3, 4, 5], start: "09:00", end: "18:00" };

/** The rule id a "leads gone quiet" follow-up carries (3C): LUME's own rule, not a stage's. */
export const NO_TOUCH_RULE_ID = "00000000-0000-7000-8000-00000000c0de";

const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use a time like 09:00");
const unique = <T>(xs: T[]) => new Set(xs).size === xs.length;

export const workingHoursSchema = z
  .object({
    days: z
      .array(z.number().int().min(0).max(6))
      .min(1, "Pick at least one working day")
      .max(7)
      .refine(unique, "Each day once"),
    start: time,
    end: time,
  })
  .strict()
  .refine((w) => w.start < w.end, { message: "The day has to end after it starts", path: ["end"] });

export const duePresetSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9_]{1,40}$/),
    label: z.string().trim().min(1, "Give it a name").max(40),
    rule: z.union([
      z
        .object({
          in: z.object({ n: z.number().int().min(1).max(999), unit: z.enum(["minute", "hour", "day"]) }),
        })
        .strict(),
      z.object({ at: z.object({ days: z.number().int().min(0).max(30), time }) }).strict(),
      z.object({ weekday: z.object({ day: z.number().int().min(0).max(6), time }) }).strict(),
    ]),
  })
  .strict();

export const duePresetsSchema = z
  .array(duePresetSchema)
  .min(1, "Keep at least one time choice")
  .max(8, "Up to eight time choices")
  .refine((ps) => unique(ps.map((p) => p.id)), "Each time choice once");

const person = z.union([z.literal("lead_owner"), z.object({ userId: z.uuid() }).strict()]);

export const stageRuleSchema = z.discriminatedUnion("type", [
  z
    .object({
      id: z.uuid(),
      type: z.literal("create_task"),
      title: z.string().trim().min(1, "Give the follow-up a title").max(200),
      dueIn: z.object({ n: z.number().int().min(1).max(365), unit: z.enum(["hour", "day"]) }).strict(),
      assignee: person,
    })
    .strict(),
  z.object({ id: z.uuid(), type: z.literal("cancel_open_tasks") }).strict(),
  z
    .object({
      id: z.uuid(),
      type: z.literal("notify"),
      to: z.array(person).min(1, "Pick who to tell").max(10),
    })
    .strict(),
]);

export const onEnterSchema = z
  .object({
    rules: z
      .array(stageRuleSchema)
      .max(5, "Up to five automations on a stage")
      .refine((rs) => unique(rs.map((r) => r.id)), "Each automation once"),
  })
  .strict();

export type StageRule = z.infer<typeof stageRuleSchema>;
export type OnEnter = z.infer<typeof onEnterSchema>;
export type RulePerson = z.infer<typeof person>;

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const count = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"}`;

/** A time choice as people say it: "in 30 minutes", "tomorrow at 10:00", "next Monday at 10:00". */
export function describePreset(p: DuePresetDef): string {
  const r = p.rule;
  if ("in" in r) return `in ${count(r.in.n, r.in.unit)}`;
  if ("weekday" in r) return `next ${DAYS[r.weekday.day]} at ${r.weekday.time}`;
  const day = r.at.days === 0 ? "today" : r.at.days === 1 ? "tomorrow" : `in ${r.at.days} days`;
  return `${day} at ${r.at.time}`;
}

const who = (p: RulePerson, names: Map<string, string>) =>
  p === "lead_owner" ? "the lead's owner" : (names.get(p.userId) ?? "someone who's no longer here");

/** A stage's automation in one plain sentence, for the stage editor's summary line. */
export function describeRule(rule: StageRule, names: Map<string, string>): string {
  switch (rule.type) {
    case "create_task":
      return `Sets a follow-up for ${who(rule.assignee, names)} in ${count(rule.dueIn.n, rule.dueIn.unit)}: ${rule.title}`;
    case "cancel_open_tasks":
      return "Clears the lead's open follow-ups";
    case "notify": {
      const list = rule.to.map((p) => who(p, names));
      return `Tells ${list.length > 1 ? `${list.slice(0, -1).join(", ")} and ${list.at(-1)}` : list[0]}`;
    }
  }
}
