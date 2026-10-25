import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { providerFromConfig } from "../../apps/api/src/ai/from-config";
import type { AiProvider } from "../../apps/api/src/ai/provider";
import {
  autopilotFirstOutput,
  autopilotInput,
  autopilotInstructions,
  autopilotReplyOutput,
  catchUpOutput,
  inputFor,
  instructionsFor,
  nextStepOutput,
  type AutopilotFirst,
  type AutopilotReply,
} from "../../packages/core/src/index";
import {
  AUTOPILOT_MARKS,
  ctxFor,
  scoreFirst,
  scoreReply,
  summarizeAutopilot,
  type AutopilotCase,
  type Profiles,
  type ReplyScore,
} from "./autopilot";
import {
  factsFor,
  MARKS,
  NOW,
  scoreNextStep,
  summarize,
  ungrounded,
  type Businesses,
  type CatchUpCase,
  type NextStepCase,
  type NextStepScore,
} from "./score";

const USAGE = `usage: node scripts/ai-eval.mjs --provider anthropic|google|fake --model <id> [--yes]
       [--only next-step|catch-up|autopilot] [--limit <n>] [--price-in <usd per 1M>] [--price-out <usd per 1M>] [--out <file>]
A real provider spends money on every run: it needs --yes, and the key in LUME_AI_KEY.`;

type Args = {
  provider: "anthropic" | "google" | "fake";
  model: string;
  yes: boolean;
  only: "next-step" | "catch-up" | "autopilot" | null;
  limit: number;
  priceIn: number | null;
  priceOut: number | null;
  out: string | null;
};

function parse(argv: string[]): Args | string {
  const get = (name: string) => {
    const i = argv.indexOf(`--${name}`);
    return i === -1 ? undefined : argv[i + 1];
  };
  const provider = get("provider");
  if (provider !== "anthropic" && provider !== "google" && provider !== "fake") return USAGE;
  const model = get("model") ?? (provider === "fake" ? "fake-1" : undefined);
  if (!model) return USAGE;
  const only = get("only") ?? null;
  if (only !== null && only !== "next-step" && only !== "catch-up" && only !== "autopilot") return USAGE;
  const num = (v: string | undefined) => (v === undefined ? null : Number(v));
  return {
    provider,
    model,
    yes: argv.includes("--yes"),
    only,
    limit: num(get("limit")) ?? Infinity,
    priceIn: num(get("price-in")),
    priceOut: num(get("price-out")),
    out: get("out") ?? null,
  };
}

const lines = <T>(file: string): T[] =>
  readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as T);

/**
 * LUME AI's eval (plan 2026-10-18 Task 11): every case through the provider exactly as the API sends it, the cleaner
 * after, then scored. Prints the misses, the share right per field, tokens and (given prices) cost. Exit 0 only
 * when the next-step marks pass.
 */
export async function run(argv: string[], root: string): Promise<number> {
  const a = parse(argv);
  if (typeof a === "string") {
    console.error(a);
    return 2;
  }
  if (a.provider !== "fake" && !a.yes) {
    console.error(`Not run: ${a.provider} ${a.model} is a paid model. Add --yes once the spend is approved.`);
    return 2;
  }
  const key = process.env.LUME_AI_KEY;
  if (a.provider !== "fake" && !key) {
    console.error("Not run: put the provider key in LUME_AI_KEY.");
    return 2;
  }
  const provider: AiProvider = providerFromConfig({
    LUME_AI_PROVIDER: a.provider,
    LUME_AI_MODEL: a.model,
    LUME_AI_KEY: key,
  })!;
  const dir = path.join(root, "evals", "ai");
  const businesses = JSON.parse(readFileSync(path.join(dir, "businesses.json"), "utf8")) as Businesses;
  const tokens = { input: 0, output: 0 };
  const report: Record<string, unknown> = { provider: a.provider, model: a.model, now: NOW, marks: MARKS };

  const read = async <T>(task: "next_step" | "catch_up", input: string): Promise<T> => {
    const r = await provider.read({
      instructions: instructionsFor(task),
      input,
      schema: (task === "next_step" ? nextStepOutput : catchUpOutput) as never,
      maxOutputTokens: task === "next_step" ? 2000 : 1500,
      signal: AbortSignal.timeout(30_000),
    });
    tokens.input += r.inputTokens;
    tokens.output += r.outputTokens;
    return r.output as T;
  };

  let pass = true;
  const runs = (part: "next-step" | "catch-up" | "autopilot") => a.only === null || a.only === part;
  if (runs("next-step")) {
    const cases = lines<NextStepCase>(path.join(dir, "next-step.jsonl")).slice(0, a.limit);
    const scores: NextStepScore[] = [];
    const failed: { id: string; error: string }[] = [];
    console.log(`Next step: ${cases.length} notes, ${a.provider} ${a.model}`);
    for (const c of cases) {
      const f = factsFor(c, businesses);
      try {
        const s = scoreNextStep(c, await read("next_step", inputFor("next_step", f.facts, c.note)), f);
        scores.push(s);
        const miss = (["stage", "followUp", "lostReason", "tags"] as const).filter((k) => !s[k]);
        if (miss.length || s.invented)
          console.log(
            `  ${c.id}  missed ${miss.join(", ") || "nothing"}${s.invented ? `; ${s.invented} made-up id(s), cleaned` : ""}` +
              `  -> stage ${f.keyOf(s.cleaned.stageId) ?? "stay"}, follow-up ${s.cleaned.followUp?.at ?? "none"},` +
              ` tags [${s.cleaned.tagIds.map((t) => f.keyOf(t)).join(", ")}]`,
          );
      } catch (e) {
        // An unreadable or failed answer is a miss on every field: the person would see no suggestion.
        failed.push({ id: c.id, error: e instanceof Error ? e.message : String(e) });
        console.log(`  ${c.id}  no answer: ${failed.at(-1)!.error}`);
        scores.push({
          id: c.id,
          stage: false,
          followUp: false,
          lostReason: false,
          tags: false,
          past: false,
          invented: 0,
          inventedAfter: 0,
          cleaned: null as never,
        });
      }
    }
    const sum = summarize(scores);
    pass = sum.pass;
    report.nextStep = { ...sum, failed, scores };
    const pct = (x: number) => `${Math.round(x * 100)}%`;
    console.log(
      `  stage ${pct(sum.stage)} (mark ${pct(MARKS.stage)}), follow-up ${pct(sum.followUp)} (mark ${pct(MARKS.followUp)}),` +
        ` lost reason ${pct(sum.lostReason)}, tags ${pct(sum.tags)}; past follow-ups ${sum.past}, made-up ids` +
        ` ${sum.invented} before the cleaner and ${sum.inventedAfter} after; no answer ${failed.length}`,
    );
    console.log(`  ${sum.pass ? "PASSES" : "DOES NOT PASS"} LUME's marks`);
  }

  if (runs("catch-up")) {
    const cases = lines<CatchUpCase>(path.join(dir, "catch-up.jsonl")).slice(0, a.limit);
    const out: { id: string; lines?: string[]; ungrounded?: string[]; error?: string }[] = [];
    console.log(`\nCatch-up: ${cases.length} leads (check each line against its history by hand)`);
    for (const c of cases) {
      const { facts } = factsFor(c, businesses);
      try {
        const r = await read<{ lines: string[] }>("catch_up", inputFor("catch_up", facts));
        const flagged = ungrounded(r.lines, (c.history ?? []).map((h) => h.text).join("\n"));
        out.push({ id: c.id, lines: r.lines, ungrounded: flagged });
        console.log(
          `  ${c.id}${flagged.length ? `  CHECK: numbers not in the history: ${flagged.join(", ")}` : ""}`,
        );
        for (const l of r.lines) console.log(`      ${l}`);
      } catch (e) {
        out.push({ id: c.id, error: e instanceof Error ? e.message : String(e) });
        console.log(`  ${c.id}  no answer: ${out.at(-1)!.error}`);
      }
    }
    report.catchUp = out;
  }

  if (runs("autopilot")) {
    const profiles = JSON.parse(readFileSync(path.join(dir, "autopilot-profiles.json"), "utf8")) as Profiles;
    const cases = lines<AutopilotCase>(path.join(dir, "autopilot.jsonl")).slice(0, a.limit);
    const replies: ReplyScore[] = [];
    const firsts: boolean[] = [];
    const failed: { id: string; error: string }[] = [];
    console.log(`
Autopilot: ${cases.length} cases (read every message by hand for tone and words)`);
    for (const c of cases) {
      const x = ctxFor(c, businesses, profiles);
      const task = c.task === "first" ? "autopilot_first" : "autopilot_reply";
      try {
        const r = await provider.read({
          instructions: autopilotInstructions(task, x.ctx),
          input: autopilotInput(task, x.ctx),
          schema: (task === "autopilot_first" ? autopilotFirstOutput : autopilotReplyOutput) as never,
          // As a run asks it (engine.ts): a short answer for a template's choice, room for a reply.
          maxOutputTokens: task === "autopilot_first" ? 300 : 1200,
          signal: AbortSignal.timeout(30_000),
        });
        tokens.input += r.inputTokens;
        tokens.output += r.outputTokens;
        if (c.task === "first") {
          const right = scoreFirst(c, r.output as AutopilotFirst, x);
          firsts.push(right);
          console.log(`  ${c.id}  ${right ? "right template" : "WRONG template"}`);
          continue;
        }
        const s = scoreReply(c, r.output as AutopilotReply, x);
        replies.push(s);
        const miss = (["kind", "script", "files", "stage", "lostReason", "mentions"] as const).filter(
          (k) => !s[k],
        );
        const worst = [
          s.stopAnswered && "A STOP WAS ANSWERED",
          s.riskMissed && "A RISK WAS ANSWERED",
          s.held && "held by the guards",
        ]
          .filter(Boolean)
          .join("; ");
        console.log(
          `  ${c.id}  ${(r.output as AutopilotReply).kind}${miss.length ? `  missed ${miss.join(", ")}` : ""}${worst ? `  ${worst}` : ""}`,
        );
        console.log(`      ${s.sent ?? `(no message: ${s.why})`}`);
      } catch (e) {
        // No answer is a miss on every mark: the lead would go to Needs you.
        failed.push({ id: c.id, error: e instanceof Error ? e.message : String(e) });
        console.log(`  ${c.id}  no answer: ${failed.at(-1)!.error}`);
        if (c.task === "first") firsts.push(false);
        else
          replies.push({
            id: c.id,
            kind: false,
            held: false,
            stopAnswered: false,
            riskMissed: false,
            script: true,
            files: false,
            stage: false,
            lostReason: false,
            mentions: false,
            sent: null,
            why: failed.at(-1)!.error,
          });
      }
    }
    const sum = summarizeAutopilot(replies, firsts);
    pass = pass && sum.pass;
    report.autopilot = { ...sum, marks: AUTOPILOT_MARKS, failed, replies, firsts };
    const pct = (v: number) => `${Math.round(v * 100)}%`;
    console.log(
      `  kind ${pct(sum.kind)} (mark ${pct(AUTOPILOT_MARKS.kind)}), held ${pct(sum.held)} (at most ${pct(AUTOPILOT_MARKS.held)}),` +
        ` stops answered ${sum.stopsAnswered}, risks answered ${sum.risksMissed}, wrong script ${sum.wrongScript},` +
        ` first template ${pct(sum.first)} (mark ${pct(AUTOPILOT_MARKS.first)}); no answer ${failed.length}`,
    );
    console.log(`  ${sum.pass ? "PASSES" : "DOES NOT PASS"} the Autopilot marks`);
  }

  const cost =
    a.priceIn !== null && a.priceOut !== null
      ? (tokens.input * a.priceIn + tokens.output * a.priceOut) / 1_000_000
      : null;
  report.tokens = { ...tokens, costUsd: cost };
  console.log(
    `\nTokens: ${tokens.input} in, ${tokens.output} out${cost === null ? " (add --price-in/--price-out for cost)" : `, about $${cost.toFixed(4)}`}`,
  );
  if (a.out) writeFileSync(a.out, JSON.stringify(report, null, 2));
  return pass ? 0 : 1;
}
