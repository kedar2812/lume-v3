import {
  VARIABLES,
  cleanTemplateDrafts,
  mergeAiProfile,
  templateDraftInput,
  templateDraftInstructions,
  templateDraftOutput,
  type TemplateDraft,
  type TemplateDraftCtx,
} from "@lume/core";
import { schema } from "@lume/db";
import { eq, isNull } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import type { AppDeps } from "../../app";
import { HttpError, badRequest } from "../../http/errors";
import { loadFieldRegistry } from "../../leads/fields";
import { aiStatus, runRead } from "../ai/service";

/**
 * LUME AI writes templates (owner, 2026-10-31): what the person asks for, as two or three drafts the business could
 * submit as written (`cleanTemplateDrafts`). About the business, never a lead: its words, its price list, the
 * variables a template may use. One read, counted against the month as every read is.
 */
export async function draftTemplates(
  req: FastifyRequest,
  d: AppDeps,
  body: { prompt: string },
): Promise<{ options: TemplateDraft[] }> {
  const prompt = body.prompt.trim();
  if (!prompt) throw badRequest("EMPTY", "Say what the template is for.");
  if (!(await aiStatus(req, d)).on)
    throw badRequest("AI_OFF", "LUME AI is off. An admin can switch it on in Settings → Integrations.");
  const [s] = await req.db
    .select({ name: schema.settings.businessName, currency: schema.settings.currency })
    .from(schema.settings)
    .where(eq(schema.settings.id, 1));
  const [p] = await req.db.select({ p: schema.aiProfile.profile }).from(schema.aiProfile);
  const registry = await loadFieldRegistry(req);
  const T = schema.messageTemplates;
  const existing = await req.db.select({ name: T.name }).from(T).where(isNull(T.archivedAt));
  const c: TemplateDraftCtx = {
    business: s?.name ?? "",
    prompt,
    profile: mergeAiProfile(p?.p ?? null, {}),
    currency: s?.currency ?? "",
    // Meetings' variables only fill in for a lead with a meeting: a draft for everyone leaves them out.
    variables: VARIABLES(registry.defs as never)
      .filter((v) => !("needs" in v && v.needs))
      .map((v) => ({ token: v.token, label: v.label })),
    existing: existing.map((t) => t.name),
  };
  const r = await runRead(req, d, {
    task: "template_draft",
    leadId: null,
    instructions: templateDraftInstructions(c),
    input: templateDraftInput(c),
    schema: templateDraftOutput,
    maxOutputTokens: 1600,
  });
  if ("unavailable" in r)
    throw r.unavailable === "limit"
      ? new HttpError(
          429,
          "AI_LIMIT",
          "LUME AI has reached its limit for now. Try again later, or ask for a top-up.",
        )
      : new HttpError(503, "AI_UNAVAILABLE", "LUME AI couldn't write these just now. Try again.");
  return { options: cleanTemplateDrafts(r.output, c) };
}
