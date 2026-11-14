import type { LiveSheetRule } from "./rule";

type Names = {
  stage(id: string): string;
  source(id: string): string;
  tag(id: string): string;
  person(id: string): string;
  team(id: string): string;
};

const list = (xs: string[], joiner: "or" | "and" = "or") =>
  xs.length <= 1 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} ${joiner} ${xs.at(-1)}`;

const day = (ymd: string) =>
  new Date(`${ymd}T12:00:00Z`).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });

/** A live sheet's rule in words: "Leads that reached Qualified, from Instagram". */
export function ruleWords(rule: LiveSheetRule, names: Names): string {
  const stages = list(rule.stages.stageIds.map(names.stage));
  const parts = [rule.stages.mode === "reached" ? `Leads that reached ${stages}` : `Leads in ${stages}`];
  if (rule.sourceIds?.length) parts.push(`from ${list(rule.sourceIds.map(names.source))}`);
  if (rule.tagIds?.length) parts.push(`tagged ${list(rule.tagIds.map(names.tag))}`);
  if (rule.ownerIds?.length) parts.push(`owned by ${list(rule.ownerIds.map(names.person))}`);
  if (rule.teamIds?.length) parts.push(`in the ${list(rule.teamIds.map(names.team))} team`);
  if (rule.addedOnOrAfter) parts.push(`added on or after ${day(rule.addedOnOrAfter)}`);
  return parts.join(", ");
}
