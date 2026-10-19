import { createHash, randomBytes } from "node:crypto";
import { and, asc, eq, isNull, ne, sql } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { instanceIdOf, newId, sign, unseal, verify, type Handoff } from "@lume/core";
import { schema } from "@lume/db";
import type { AppDeps } from "../../app";
import { audit } from "../../audit/audit";
import { HttpError, badRequest, notFound } from "../../http/errors";
import { assertModule } from "../../licence/plan";
import { integrationsView } from "../sheets/service";
import type { KeepMonths } from "./keep";
import { metaClient } from "./meta";

const N = schema.whatsappNumbers;
const OC = schema.oauthConnects;
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
export const tokenContext = (id: string) => `whatsapp-number:${id}`;
/** The relay WhatsApp goes through: its own when set (e2e), else Connect with Google's — one relay on a client's server. */
export const relayOf = (d: AppDeps) => d.whatsappRelay ?? d.googleOAuth ?? null;

const notConfigured = () =>
  new HttpError(
    409,
    "NOT_CONFIGURED",
    "WhatsApp comes through LUME's relay, which isn't set up on this server yet.",
  );
const whatsappOff = () =>
  new HttpError(
    409,
    "WHATSAPP_OFF",
    "WhatsApp is switched off. An admin can switch it on in Settings → Integrations.",
  );

export async function whatsappOn(req: FastifyRequest): Promise<boolean> {
  const [s] = await req.db
    .select({ i: schema.settings.integrations })
    .from(schema.settings)
    .where(eq(schema.settings.id, 1));
  return !!s?.i.whatsapp?.enabled;
}

async function requireOn(req: FastifyRequest, d: AppDeps) {
  if (!relayOf(d) || !d.meta) throw notConfigured();
  if (!(await whatsappOn(req))) throw whatsappOff();
}

/**
 * Settings → Integrations → WhatsApp (admins): the switch (off by default; on only while the plan includes it) and how
 * long LUME keeps WhatsApp's files (forever by default). Each is changed alone and the other kept: switching WhatsApp
 * off and on never loses "keep for".
 */
export async function setWhatsAppSettings(
  req: FastifyRequest,
  d: AppDeps,
  body: {
    enabled?: boolean | undefined;
    keepFilesMonths?: KeepMonths | undefined;
    replyFromLume?: boolean | undefined;
  },
) {
  if (body.enabled) {
    assertModule(req, "whatsapp");
    if (!relayOf(d) || !d.meta) throw notConfigured();
  }
  const patch: { enabled?: boolean; keepFilesMonths?: KeepMonths; replyFromLume?: boolean } = {};
  if (body.enabled !== undefined) patch.enabled = body.enabled;
  if (body.keepFilesMonths !== undefined) patch.keepFilesMonths = body.keepFilesMonths;
  if (body.replyFromLume !== undefined) patch.replyFromLume = body.replyFromLume;
  const [before] = await req.db
    .select({ i: schema.settings.integrations })
    .from(schema.settings)
    .where(eq(schema.settings.id, 1));
  await req.db.execute(
    sql`UPDATE settings SET integrations = jsonb_set(integrations, '{whatsapp}',
          coalesce(integrations -> 'whatsapp', '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb) WHERE id = 1`,
  );
  if (body.enabled !== undefined)
    await audit(req, {
      action: body.enabled ? "integration.enabled" : "integration.disabled",
      entityType: "integration",
      diff: { module: "whatsapp" },
    });
  if (body.keepFilesMonths !== undefined)
    await audit(req, {
      action: "integration.updated",
      entityType: "integration",
      diff: {
        module: "whatsapp",
        keepFilesMonths: { from: before?.i.whatsapp?.keepFilesMonths ?? null, to: body.keepFilesMonths },
      },
    });
  // Replying from LUME (plan W3a): off by default, an admin's choice, in the audit log.
  if (body.replyFromLume !== undefined)
    await audit(req, {
      action: "integration.updated",
      entityType: "integration",
      diff: {
        module: "whatsapp",
        replyFromLume: { from: !!before?.i.whatsapp?.replyFromLume, to: body.replyFromLume },
      },
    });
  return integrationsView(req, d);
}

/** The connected numbers, for the card: never a token. */
export async function numbersView(req: FastifyRequest) {
  const rows = await req.db
    .select({
      id: N.id,
      display: N.displayPhone,
      name: N.verifiedName,
      ownerId: N.ownerUserId,
      ownerName: schema.users.name,
      status: N.status,
      problem: N.problem,
      historyShared: N.historyShared,
      connectedAt: N.connectedAt,
    })
    .from(N)
    .leftJoin(schema.users, eq(schema.users.id, N.ownerUserId))
    .where(ne(N.status, "disconnected"))
    .orderBy(asc(N.connectedAt));
  return {
    numbers: rows.map((r) => ({
      id: r.id,
      display: r.display,
      name: r.name,
      owner: r.ownerId ? { id: r.ownerId, name: r.ownerName ?? "" } : null,
      status: r.status,
      problem: r.problem,
      historyShared: r.historyShared,
      connectedAt: r.connectedAt.toISOString(),
    })),
  };
}

/** A signed link to the relay's Embedded Signup: the kind is signed with the nonce, as a calendar's. */
export async function connectStart(req: FastifyRequest, d: AppDeps) {
  await requireOn(req, d);
  const { relayUrl, relayToken } = relayOf(d)!;
  const nonce = randomBytes(24).toString("base64url");
  await req.db
    .insert(OC)
    .values({ id: newId(), userId: req.actor!.userId, nonceHash: sha256(nonce), kind: "whatsapp" });
  const url = new URL("/wa/start", relayUrl);
  url.search = new URLSearchParams({
    i: instanceIdOf(relayToken),
    n: nonce,
    s: sign(relayToken, `${nonce}.whatsapp`),
  }).toString();
  return { url: url.toString() };
}

/**
 * Back from Embedded Signup (spec 2026-10-18 §3.2): signed and sealed with this instance's token, a WhatsApp hand-back,
 * fresh, and matching a connect this same admin started — once. The number's token is kept encrypted; connecting the
 * same number again replaces it.
 */
export async function connectComplete(req: FastifyRequest, d: AppDeps, body: { p: string; s: string }) {
  await requireOn(req, d);
  const token = relayOf(d)!.relayToken;
  const invalid = () =>
    badRequest("CONNECT_INVALID", "This connection isn't valid. Try connecting the number again.");
  if (!verify(token, body.p, body.s)) throw invalid();
  const h = unseal<Handoff>(token, body.p);
  const w = h?.whatsapp;
  if (!h || h.kind !== "whatsapp" || typeof h.nonce !== "string" || !w || typeof w.token !== "string")
    throw invalid();
  if (h.exp < Date.now())
    throw badRequest("CONNECT_EXPIRED", "This connection took too long. Try connecting the number again.");
  const uid = req.actor!.userId;
  const [open] = await req.db
    .select({ id: OC.id })
    .from(OC)
    .where(
      and(
        eq(OC.nonceHash, sha256(h.nonce)),
        eq(OC.userId, uid),
        eq(OC.kind, "whatsapp"),
        isNull(OC.completedAt),
      ),
    )
    .for("update");
  if (!open)
    throw notFound("CONNECT_NOT_FOUND", "This connection was already used, or isn't yours. Try again.");
  await req.db.delete(OC).where(eq(OC.id, open.id));

  const [was] = await req.db
    .select({ id: N.id })
    .from(N)
    .where(eq(N.phoneNumberId, w.phoneNumberId))
    .for("update");
  const id = was?.id ?? newId();
  const fields = {
    wabaId: w.wabaId,
    displayPhone: w.display,
    verifiedName: w.name,
    runAs: uid,
    tokenEnc: d.keyring.encrypt(w.token, tokenContext(id)),
    status: "active" as const,
    problem: null,
    historyShared: w.history,
    updatedAt: new Date(),
  };
  if (was)
    await req.db
      .update(N)
      .set({ ...fields, connectedAt: new Date() })
      .where(eq(N.id, id));
  else await req.db.insert(N).values({ id, phoneNumberId: w.phoneNumberId, ownerUserId: null, ...fields });
  await audit(req, {
    action: was ? "whatsapp.reconnected" : "whatsapp.connected",
    entityType: "whatsapp_number",
    entityId: id,
    diff: { display: w.display, history: w.history },
  });
  return numbersView(req);
}

async function numberOf(req: FastifyRequest, id: string) {
  const [n] = await req.db
    .select()
    .from(N)
    .where(and(eq(N.id, id), ne(N.status, "disconnected")))
    .for("update");
  if (!n) throw notFound("NUMBER_NOT_FOUND", "That number isn't connected to LUME.");
  return n;
}

/** Whose number it is: a person (their leads' replies come to them), or the business (null). */
export async function setOwner(req: FastifyRequest, id: string, ownerId: string | null) {
  const n = await numberOf(req, id);
  if (ownerId) {
    const [u] = await req.db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(and(eq(schema.users.id, ownerId), eq(schema.users.status, "active")));
    if (!u) throw badRequest("OWNER_INVALID", "Pick someone who uses LUME now.");
  }
  await req.db.update(N).set({ ownerUserId: ownerId, updatedAt: new Date() }).where(eq(N.id, n.id));
  await audit(req, {
    action: "whatsapp.owner",
    entityType: "whatsapp_number",
    entityId: n.id,
    diff: { ownerId },
  });
  return numbersView(req);
}

/**
 * Disconnect: Meta stops delivering (best effort — a token it already refuses can't unsubscribe, and the number goes
 * anyway), the token is dropped, and its "Not a lead yet" with it. What it brought to leads stays on them.
 */
export async function disconnect(req: FastifyRequest, d: AppDeps, id: string) {
  const n = await numberOf(req, id);
  if (d.meta && n.tokenEnc)
    await metaClient(d.meta, d.keyring.decrypt(n.tokenEnc, tokenContext(n.id)))
      .unsubscribe(n.wabaId)
      .catch((err: unknown) => req.log.warn({ err }, "couldn't unsubscribe a WhatsApp account at Meta"));
  // Its strangers go, whoever's they were: widened for this one statement, then put back as it was.
  const prev = await req.db.execute<{ s: string | null }>(
    sql`SELECT current_setting('lume.lead_scope', true) AS s`,
  );
  await req.db.execute(sql`SELECT set_config('lume.lead_scope', 'all', true)`);
  await req.db.delete(schema.whatsappInbox).where(eq(schema.whatsappInbox.numberId, n.id));
  await req.db.execute(sql`SELECT set_config('lume.lead_scope', ${prev.rows[0]?.s ?? ""}, true)`);
  await req.db
    .update(N)
    .set({ status: "disconnected", tokenEnc: null, problem: null, updatedAt: new Date() })
    .where(eq(N.id, n.id));
  await audit(req, { action: "whatsapp.disconnected", entityType: "whatsapp_number", entityId: n.id });
  return numbersView(req);
}
