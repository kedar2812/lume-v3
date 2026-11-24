import {
  AI_OUTPUT_TOKENS,
  buildFromAnswer,
  flowBuildInput,
  flowBuildInstructions,
  flowBuildOutput,
  mergeAiProfile,
  newId,
  toGraph,
  type FlowBuildCtx,
  type GraphOp,
} from "@lume/core";
import { schema } from "@lume/db";
import { sql } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import type { AppDeps } from "../../app";
import { audit } from "../../audit/audit";
import { HttpError, badRequest } from "../../http/errors";
import { loadFieldRegistry } from "../../leads/fields";
import { aiStatus, runRead } from "../ai/service";
import { isFieldVisible } from "../leads/serialize";
import { flowOf, gotoTargets, requireFlows } from "./flow-admin";

/** A whole flow takes longer to write than a note's answer. */
const BUILD_MS = 90_000;
const CONTACT = new Set(["phone", "email", "url", "instagram"]);
const KIND_WORDS: Record<string, string> = {
  comment: "A comment",
  dm: "A DM",
  story_reply: "A reply to a story",
  story_mention: "A story mention",
  ad: "A message from an ad",
  welcome: "A first message",
};

/**
 * LUME AI builds a flow (plan 2026-11-23-flow-builder, Task C1): the person says what the flow should do, LUME AI
 * answers with the whole flow, and LUME repairs it or refuses it (`buildFromAnswer`) and answers with the steps the
 * builder plays into its draft. Nothing is written here: the builder saves the result like any edit, against the
 * draft's rev, so the live version is never touched. About the business, never a lead: its stages, tags and
 * non-contact fields, and the flow itself.
 */
export async function aiBuildFlow(
  req: FastifyRequest,
  d: AppDeps,
  id: string,
  body: { prompt: string; selection?: string[] | undefined },
): Promise<{ plan: string[]; said: string; ops: GraphOp[]; refused: boolean }> {
  await requireFlows(req);
  const prompt = body.prompt.trim();
  if (!prompt) throw badRequest("EMPTY", "Say what the flow should do.");
  const f = await flowOf(req, id, false);
  if (!(await aiStatus(req, d)).on)
    throw badRequest("AI_OFF", "LUME AI is off. An admin can switch it on in Settings → Integrations.");
  const draft = toGraph(f.draft_steps);
  const ids = new Set(draft.nodes.map((n) => n.id));
  const [s] = await req.db.select({ name: schema.settings.businessName }).from(schema.settings);
  const [p] = await req.db.select({ p: schema.aiProfile.profile }).from(schema.aiProfile);
  const stages = await req.db.execute<{ id: string; name: string }>(
    sql`SELECT id, name FROM stages WHERE archived_at IS NULL ORDER BY position, name`,
  );
  const tags = await req.db.execute<{ id: string; label: string }>(
    sql`SELECT id, label FROM tags ORDER BY label`,
  );
  const registry = await loadFieldRegistry(req);
  const triggers = await req.db.execute<{ kind: string; keywords: string[] }>(
    sql`SELECT kind, keywords FROM instagram_triggers WHERE flow_id = ${id} AND enabled ORDER BY created_at`,
  );
  const c: FlowBuildCtx = {
    business: s?.name ?? "",
    about: mergeAiProfile(p?.p ?? null, {}).knows.about,
    prompt,
    selection: [...new Set(body.selection ?? [])].filter((x) => ids.has(x)),
    trigger: triggers.rows
      .map(
        (t) =>
          `${KIND_WORDS[t.kind] ?? "A message"}${t.keywords.length ? ` with ${t.keywords.join(", ")}` : ""}`,
      )
      .join("; "),
    stages: stages.rows,
    tags: tags.rows,
    fields: registry.defs
      .filter(
        (x) =>
          !x.archived &&
          !CONTACT.has(x.type) &&
          isFieldVisible({ actor: req.actor!, fields: registry }, x.key),
      )
      .map((x) => ({ key: x.key, label: x.label })),
    // The checks' own answer (problemsOf): LUME AI doesn't answer Instagram conversations yet.
    ai: false,
    flows: await gotoTargets(req, id),
    self: id,
    newId,
  };
  const r = await runRead(req, d, {
    task: "flow_build",
    leadId: null,
    instructions: flowBuildInstructions(c),
    input: flowBuildInput(c, draft),
    schema: flowBuildOutput,
    maxOutputTokens: AI_OUTPUT_TOKENS.flow_build,
    timeoutMs: BUILD_MS,
    // The read keeps its size, not the flow: the flow is the business's, in its own table.
    store: (o) => ({ steps: o.steps.length }),
  });
  if ("unavailable" in r)
    throw r.unavailable === "limit"
      ? new HttpError(
          429,
          "AI_LIMIT",
          "LUME AI has reached its limit for now. Try again later, or ask for a top-up.",
        )
      : new HttpError(503, "AI_UNAVAILABLE", "LUME AI couldn't build this just now. Try again.");
  const out = buildFromAnswer(draft, r.output, c);
  await audit(req, {
    action: "instagram.flow.ai",
    entityType: "instagram_flow",
    entityId: id,
    diff: { steps: out.graph.nodes.length, ops: out.ops.length, refused: out.refused },
  });
  return { plan: out.plan, said: out.said, ops: out.ops, refused: out.refused };
}
