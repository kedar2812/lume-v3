import { and, eq, inArray, sql } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { paramsFor, render } from "@lume/core";
import { schema } from "@lume/db";
import type { AppDeps } from "../../app";
import { HttpError, badRequest, conflict, notFound } from "../../http/errors";
import type { LeadRow } from "../leads/serialize";
import { contextFor } from "../leads/sending";
import { visibleLead } from "../leads/service";
import { lastInbound, replyOn, sendReply, type SendLimiter } from "../whatsapp/send";
import { pickNumber, sendableNumbers, type SendableNumber } from "../whatsapp/send-from";
import { approvedFor, labelsOf, numberFor, sendTemplate } from "../whatsapp/template-send";
import type { ThreadMessage } from "../whatsapp/thread";
import {
  WHY,
  assertRunning,
  capReached,
  itemAt,
  plannedText,
  queueRow,
  queueView,
  settle,
  step,
  versionUsable,
  whyNot,
  type QueueView,
  type Refused,
  type Step,
} from "./service";

/**
 * The focus run inside LUME (spec 2026-11-26-focus-run-in-lume): how each lead goes (through LUME, with WhatsApp's
 * 24 hours and the run's approved template, or WhatsApp's own way as before), sending it from the run, and the
 * leads LUME AI took leaving it. A send counts as "Sent? Yes" did, through the code that counts every send from LUME.
 */
const I = schema.sendQueueItems;
const Q = schema.sendQueues;
const WINDOW_MS = 24 * 3_600_000;
/** A template value left as written: render() leaves {{…}} where a lead has nothing. */
const UNFILLED = /\{\{\s*[^{}]+?\s*\}\}/;

export type Channel =
  | {
      via: "lume";
      /** WhatsApp's 24 hours from their last message: inside them, a message may go as well as the template. */
      window: { open: boolean; lastInAt: string | null; until: string | null };
      /** The run's template as WhatsApp approved it, in this lead's words; null when there's none to send. */
      template: { submissionId: string; name: string; preview: string; missing: string[] } | null;
      /** The run's words for this lead (or the person's own, kept for it); null for a run in their own words. */
      text: string | null;
      /** Why nothing can go to this lead from LUME now, though it's LUME's to send (their choice stands). */
      blocked?: string;
    }
  | { via: "whatsapp"; why: string };

const REPLY_OFF =
  "Replying from LUME is off. An admin can switch it on in Settings → Integrations → WhatsApp.";
const MARKETING_OFF = "This person turned off marketing messages from you on WhatsApp.";
/** Refusals about this lead: it's skipped with why, and the run goes on. */
const LEAD_LEVEL = new Set(["MARKETING_OFF", "MISSING_VALUES", "NO_WHATSAPP"]);
/** Refusals that stop every send: the run pauses with why, as the day's cap does. */
const RUN_WIDE = new Set(["PAID_LIMIT", "NO_NUMBER", "REPLY_OFF"]);

async function channelOf(
  req: FastifyRequest,
  d: AppDeps,
  q: typeof Q.$inferSelect,
  it: typeof I.$inferSelect,
  lead: LeadRow,
): Promise<Channel> {
  if (!(await replyOn(req, d))) return { via: "whatsapp", why: REPLY_OFF };
  // One that can't be messaged at all (do not contact, not theirs): the card says why and offers Skip, as before.
  const cant = whyNot(req, lead);
  if (cant) return { via: "whatsapp", why: cant };
  if (!lead.phoneE164 || lead.phoneStatus !== "valid")
    return { via: "whatsapp", why: "This lead has no WhatsApp number." };
  // The run's own number (chosen at its start). One that started with none of the person's own: WhatsApp's way, never
  // another number. A run from before goes from the lead owner's, as it did.
  if (q.numberAsked && !q.numberId)
    return { via: "whatsapp", why: "No WhatsApp number of yours is connected to LUME." };
  const number = await numberFor(req, lead, q.numberId ?? undefined);
  if (!number)
    return {
      via: "whatsapp",
      why: q.numberId ? await goneWhy(req, q.numberId) : "Connect a WhatsApp number first.",
    };

  // WhatsApp keeps each number's 24 hours apart: only what they wrote to the run's number opens them.
  const last = await lastInbound(req, lead.id, q.numberId ?? undefined);
  const until = last?.number ? new Date(last.at.getTime() + WINDOW_MS) : null;
  const open = !!until && until > d.clock() && last!.number!.status === "active";
  const window = {
    open,
    lastInAt: last ? last.at.toISOString() : null,
    until: open && until ? until.toISOString() : null,
  };

  const usable = q.templateVersionId ? await versionUsable(req, q.templateVersionId) : false;
  const [run] =
    q.templateVersionId && usable
      ? await req.db
          .select({ templateId: schema.templateVersions.templateId, name: schema.messageTemplates.name })
          .from(schema.templateVersions)
          .innerJoin(
            schema.messageTemplates,
            eq(schema.messageTemplates.id, schema.templateVersions.templateId),
          )
          .where(eq(schema.templateVersions.id, q.templateVersionId))
      : [];
  let template: Extract<Channel, { via: "lume" }>["template"] = null;
  if (run) {
    const option = (await approvedFor(req, number.waba, lead)).find((r) => r.templateId === run.templateId);
    if (option) {
      const ctx = await contextFor(req, lead);
      const labels = labelsOf(ctx.fields as never);
      template = {
        submissionId: option.id,
        name: option.name,
        preview: render(option.body, ctx).text,
        missing: paramsFor(option.tokens, ctx).missing.map((t) => labels.get(t) ?? t),
      };
    }
  }
  const text =
    it.textOverride ??
    (q.templateVersionId && usable ? (await plannedText(req, q.templateVersionId, lead)).text : null);

  if (!open && !template) {
    // Their choice stands: never "open WhatsApp instead" for someone who turned marketing off.
    if (run && lead.whatsappMarketingOffAt && (await approvedAtAll(req, number.waba, run.templateId)))
      return { via: "lume", window, template: null, text, blocked: MARKETING_OFF };
    return {
      via: "whatsapp",
      why: run
        ? `${run.name} isn't approved by WhatsApp yet.`
        : "They haven't written in 24 hours, and a message from LUME then needs an approved template.",
    };
  }
  return { via: "lume", window, template, text };
}

/** Why a run's number can't send now, in words. */
async function goneWhy(req: FastifyRequest, numberId: string): Promise<string> {
  const [n] = await req.db
    .select({ display: schema.whatsappNumbers.displayPhone, status: schema.whatsappNumbers.status })
    .from(schema.whatsappNumbers)
    .where(eq(schema.whatsappNumbers.id, numberId));
  if (!n) return "This run's number isn't connected any more.";
  return n.status === "disconnected"
    ? `${n.display} isn't connected any more.`
    : `Connect ${n.display} again to send from LUME.`;
}

/**
 * The number a run starts on (2026-11-26): none while Reply from LUME is off (leads open WhatsApp as before);
 * otherwise the one chosen, or their only one. Two or more and none chosen: asked, never chosen for them.
 */
export async function runNumber(req: FastifyRequest, d: AppDeps, chosen: string | undefined) {
  if (!(await replyOn(req, d))) return null;
  return pickNumber(req, chosen);
}

/** The template has words WhatsApp approved on this account (whoever it may go to). */
async function approvedAtAll(req: FastifyRequest, waba: string, templateId: string): Promise<boolean> {
  const r = await req.db.execute(sql`
    SELECT 1 FROM whatsapp_template_submissions s JOIN template_versions v ON v.id = s.template_version_id
     WHERE s.waba_id = ${waba} AND s.status = 'approved' AND v.template_id = ${templateId} LIMIT 1`);
  return r.rows.length > 0;
}

/** How one lead of the run goes, for its card: through LUME (and what can go), or WhatsApp's way, and why. */
export async function itemChannel(
  req: FastifyRequest,
  d: AppDeps,
  id: string,
  position: number,
): Promise<Channel> {
  const q = await queueRow(req, id);
  const it = await itemAt(req, id, position);
  let lead: LeadRow;
  try {
    lead = await visibleLead(req, it.leadId);
  } catch (err) {
    if (!(err instanceof HttpError)) throw err;
    return { via: "whatsapp", why: WHY.gone };
  }
  return channelOf(req, d, q, it, lead);
}

/**
 * One lead of the run, sent from LUME: the run's approved template, or (inside the 24 hours) a message. Once per lead:
 * the run's row is locked for the length of this, so two tabs or a double press take turns and the second finds it
 * done. A refusal about the lead skips it with why; one that stops every send pauses the run with why.
 */
export async function sendItem(
  req: FastifyRequest,
  d: AppDeps,
  limiter: SendLimiter,
  id: string,
  position: number,
  body: { mode: "template" | "message"; text?: string | undefined; clientKey: string },
): Promise<({ message: ThreadMessage } & Step) | ({ skipped: string } & Step) | Refused> {
  const q = await queueRow(req, id, true);
  assertRunning(q);
  const it = await itemAt(req, id, position);
  if (it.status === "sending")
    throw new HttpError(409, "ITEM_TAKEN", "That lead is open in WhatsApp: say whether it was sent");
  if (it.status !== "pending") throw conflict("ITEM_DONE", "That lead is done in this run");
  const capped = await capReached(req);
  if (capped) {
    await req.db.update(Q).set({ status: "paused", pausedReason: "daily_cap" }).where(eq(Q.id, id));
    return { refused: capped };
  }
  let lead: LeadRow;
  try {
    lead = await visibleLead(req, it.leadId);
  } catch (err) {
    if (!(err instanceof HttpError)) throw err;
    await settle(req, id, position, "skipped", WHY.gone);
    return { skipped: WHY.gone, ...(await step(req, id, position)) };
  }
  const why = whyNot(req, lead);
  if (why) {
    await settle(req, id, position, "skipped", why);
    return { skipped: why, ...(await step(req, id, position)) };
  }
  const ch = await channelOf(req, d, q, it, lead);
  if (ch.via !== "lume") throw conflict("NOT_THROUGH_LUME", ch.why);
  const skip = async (words: string) => {
    await settle(req, id, position, "skipped", words);
    return { skipped: words, ...(await step(req, id, position)) };
  };
  if (ch.blocked) return skip(ch.blocked);
  let own: string | null = null;
  if (body.mode === "message") {
    if (!ch.window.open)
      throw conflict("WINDOW_CLOSED", "They haven't written in 24 hours, so only the template can go.");
    own = body.text?.trim() ? body.text : null;
    const words = own ?? ch.text ?? "";
    if (!words.trim()) throw badRequest("TEXT_REQUIRED", "Write the message for this lead");
    // A value the run's words name but this lead hasn't got: never sent to them as {{…}}.
    if (UNFILLED.test(words))
      throw new HttpError(422, "UNFILLED", "This message still has {{…}} in it. Fill it in before sending.");
  } else if (!ch.template)
    throw conflict("NO_TEMPLATE", "There's no approved template to send them. Send a message instead.");

  await req.db.execute(sql`SAVEPOINT lume_queue_send`);
  let sent: { message: ThreadMessage };
  try {
    sent =
      body.mode === "message"
        ? await sendReply(req, d, limiter, lead.id, {
            clientKey: body.clientKey,
            text: own ?? ch.text!,
            fromNumber: q.numberId ?? undefined,
          })
        : await sendTemplate(req, d, limiter, lead.id, {
            submissionId: ch.template!.submissionId,
            clientKey: body.clientKey,
            fromNumber: q.numberId ?? undefined,
          });
    await req.db.execute(sql`RELEASE SAVEPOINT lume_queue_send`);
  } catch (err) {
    await req.db.execute(sql`ROLLBACK TO SAVEPOINT lume_queue_send`);
    await req.db.execute(sql`RELEASE SAVEPOINT lume_queue_send`);
    if (!(err instanceof HttpError)) throw err;
    if (LEAD_LEVEL.has(err.code)) return skip(err.message);
    if (RUN_WIDE.has(err.code)) {
      await req.db.update(Q).set({ status: "paused", pausedReason: err.message }).where(eq(Q.id, id));
      return { refused: err };
    }
    throw err;
  }
  const [o] = await req.db
    .select({ id: schema.whatsappOutbox.id })
    .from(schema.whatsappOutbox)
    .where(eq(schema.whatsappOutbox.activityId, sent.message.id));
  await req.db
    .update(I)
    .set({ status: "sent", reason: null, doneAt: new Date(), outboxId: o?.id ?? null, textOverride: own })
    .where(and(eq(I.queueId, id), eq(I.position, position), eq(I.status, "pending")));
  return { message: sent.message, ...(await step(req, id, position)) };
}

/**
 * Let LUME AI take the rest (spec §4): the leads waiting in this run that the person's LUME AI run now holds leave
 * this one, as handed to LUME AI; the rest stay. Nothing waiting: the run is finished.
 */
export async function markHanded(req: FastifyRequest, id: string, runId: string): Promise<QueueView> {
  const q = await queueRow(req, id, true);
  if (q.status === "finished" || q.status === "cancelled") throw conflict("QUEUE_OVER", "This run is over");
  const [r] = await req.db
    .select({ id: schema.autopilotRuns.id })
    .from(schema.autopilotRuns)
    .where(and(eq(schema.autopilotRuns.id, runId), eq(schema.autopilotRuns.startedBy, req.actor!.userId)));
  if (!r) throw notFound("RUN_NOT_FOUND", "That LUME AI run doesn't exist");
  const held = await req.db
    .select({ leadId: schema.autopilotLeads.leadId })
    .from(schema.autopilotLeads)
    .where(and(eq(schema.autopilotLeads.runId, runId), eq(schema.autopilotLeads.active, true)));
  if (held.length)
    await req.db
      .update(I)
      .set({ status: "skipped", reason: "Handed to LUME AI", doneAt: new Date() })
      .where(
        and(
          eq(I.queueId, id),
          eq(I.status, "pending"),
          inArray(
            I.leadId,
            held.map((h) => h.leadId),
          ),
        ),
      );
  const [left] = await req.db
    .select({ n: sql<number>`count(*)::int` })
    .from(I)
    .where(and(eq(I.queueId, id), inArray(I.status, ["pending", "sending"])));
  if (!left?.n)
    await req.db.update(Q).set({ status: "finished", finishedAt: new Date() }).where(eq(Q.id, id));
  return queueView(req, id);
}

export type LumePlan = {
  on: boolean;
  /** The number it would send from: chosen, or their only one; null while two or more wait to be chosen. */
  numberId: string | null;
  through: number;
  inWindow: number;
  approvedTemplateIds: string[];
};

/**
 * For the run's start (the popover): the numbers this person may send from, whether leads can go through LUME at all,
 * how many of these have a number that can, how many wrote to the run's number in the last 24 hours, and which
 * templates WhatsApp approved on that number's account.
 */
export async function lumePlan(
  req: FastifyRequest,
  d: AppDeps,
  leads: LeadRow[],
  chosen?: string,
): Promise<{ lume: LumePlan; numbers: Pick<SendableNumber, "id" | "display" | "whose">[] }> {
  const off = { on: false, numberId: null, through: 0, inWindow: 0, approvedTemplateIds: [] };
  if (!(await replyOn(req, d))) return { lume: off, numbers: [] };
  const list = await sendableNumbers(req);
  const numbers = list.map(({ id, display, whose }) => ({ id, display, whose }));
  if (!list.length) return { lume: off, numbers };
  const number = chosen ? (list.find((n) => n.id === chosen) ?? null) : list.length === 1 ? list[0]! : null;
  const through = leads.filter((l) => l.phoneE164 && l.phoneStatus === "valid");
  if (!number) return { lume: { ...off, on: true, through: through.length }, numbers };
  const ids = through.map((l) => l.id);
  const wrote = ids.length
    ? await req.db.execute<{ n: number }>(sql`
        SELECT count(DISTINCT a.lead_id)::int AS n FROM activities a
         WHERE a.lead_id = ANY(${`{${ids.join(",")}}`}::uuid[]) AND a.type = 'whatsapp_received'
           AND a.payload->>'numberId' = ${number.id}
           AND a.occurred_at > ${new Date(d.clock().getTime() - WINDOW_MS)}`)
    : { rows: [{ n: 0 }] };
  const approved = await req.db.execute<{ id: string }>(sql`
    SELECT DISTINCT v.template_id AS id FROM whatsapp_template_submissions s
      JOIN template_versions v ON v.id = s.template_version_id
     WHERE s.status = 'approved' AND s.waba_id = ${number.waba}`);
  return {
    lume: {
      on: true,
      numberId: number.id,
      through: through.length,
      inWindow: wrote.rows[0]?.n ?? 0,
      approvedTemplateIds: approved.rows.map((r) => r.id),
    },
    numbers,
  };
}
