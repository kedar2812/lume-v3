import { createHash, randomBytes } from "node:crypto";
import { and, asc, eq, isNull, ne, sql } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import type pg from "pg";
import { instanceIdOf, newId, sign, unseal, verify, type Handoff, type Rules } from "@lume/core";
import { schema } from "@lume/db";
import type { AppDeps } from "../../app";
import { audit } from "../../audit/audit";
import { HttpError, badRequest, notFound } from "../../http/errors";
import { assertModule } from "../../licence/plan";
import { adminIds, notify } from "../notifications/notify";
import { integrationsView } from "../sheets/service";
import { igGraph } from "./graph";

const A = schema.instagramAccounts;
const OC = schema.oauthConnects;
const S = schema.leadSources;
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
export const igTokenContext = (id: string) => `instagram-account:${id}`;
/** The relay Instagram goes through: the same one as WhatsApp's and Connect with Google's on a client's server. */
export const instagramRelayOf = (d: AppDeps) => d.whatsappRelay ?? d.googleOAuth ?? null;
export const IG_GRAPH_DEFAULT = { graphUrl: "https://graph.instagram.com", version: "v27.0" };
export const igGraphOf = (d: AppDeps) => d.instagramGraph ?? IG_GRAPH_DEFAULT;

const notConfigured = () =>
  new HttpError(
    409,
    "NOT_CONFIGURED",
    "Instagram comes through LUME's relay, which isn't set up on this server yet.",
  );
const instagramOff = () =>
  new HttpError(
    409,
    "INSTAGRAM_OFF",
    "Instagram is switched off. An admin can switch it on in Settings → Integrations.",
  );

export async function instagramOn(req: FastifyRequest): Promise<boolean> {
  const [s] = await req.db
    .select({ i: schema.settings.integrations })
    .from(schema.settings)
    .where(eq(schema.settings.id, 1));
  return !!s?.i.instagram?.enabled;
}

async function requireOn(req: FastifyRequest, d: AppDeps) {
  if (!instagramRelayOf(d)) throw notConfigured();
  if (!(await instagramOn(req))) throw instagramOff();
}

/** Settings → Integrations → Instagram (admins): the switch, off by default; on only while the plan includes it. */
export async function setInstagramSettings(req: FastifyRequest, d: AppDeps, body: { enabled: boolean }) {
  if (body.enabled) {
    assertModule(req, "instagram");
    if (!instagramRelayOf(d)) throw notConfigured();
  }
  await req.db.execute(
    sql`UPDATE settings SET integrations = jsonb_set(integrations, '{instagram}',
          coalesce(integrations -> 'instagram', '{}'::jsonb) || ${JSON.stringify({ enabled: body.enabled })}::jsonb)
        WHERE id = 1`,
  );
  await audit(req, {
    action: body.enabled ? "integration.enabled" : "integration.disabled",
    entityType: "integration",
    diff: { module: "instagram" },
  });
  return integrationsView(req, d);
}

/** The connected accounts, for the card: never a token. */
export async function accountsView(req: FastifyRequest) {
  const rows = await req.db
    .select({
      id: A.id,
      username: A.username,
      name: A.name,
      ownerId: A.ownerUserId,
      ownerName: schema.users.name,
      status: A.status,
      problem: A.problem,
      newDmCreatesLead: A.newDmCreatesLead,
      sourceId: A.sourceId,
      connectedAt: A.connectedAt,
    })
    .from(A)
    .leftJoin(schema.users, eq(schema.users.id, A.ownerUserId))
    .where(ne(A.status, "disconnected"))
    .orderBy(asc(A.connectedAt));
  return {
    accounts: rows.map((r) => ({
      id: r.id,
      username: r.username,
      name: r.name,
      owner: r.ownerId ? { id: r.ownerId, name: r.ownerName ?? "" } : null,
      status: r.status,
      problem: r.problem,
      newDmCreatesLead: r.newDmCreatesLead,
      sourceId: r.sourceId,
      connectedAt: r.connectedAt.toISOString(),
    })),
  };
}

/** A signed link to the relay's Instagram sign-in: the kind is signed with the nonce, so another kind's link can't start it. */
export async function connectStart(req: FastifyRequest, d: AppDeps) {
  await requireOn(req, d);
  const { relayUrl, relayToken } = instagramRelayOf(d)!;
  const nonce = randomBytes(24).toString("base64url");
  await req.db
    .insert(OC)
    .values({ id: newId(), userId: req.actor!.userId, nonceHash: sha256(nonce), kind: "instagram" });
  const url = new URL("/ig/start", relayUrl);
  url.search = new URLSearchParams({
    i: instanceIdOf(relayToken),
    n: nonce,
    s: sign(relayToken, `${nonce}.instagram`),
  }).toString();
  return { url: url.toString() };
}

/** The default pipeline's first open stage: where a new account's leads start until an admin chooses. */
async function firstStage(req: FastifyRequest) {
  const [p] = await req.db
    .select({ id: schema.pipelines.id })
    .from(schema.pipelines)
    .where(and(eq(schema.pipelines.isDefault, true), sql`${schema.pipelines.archivedAt} IS NULL`));
  const [stage] = p
    ? await req.db
        .select({ id: schema.stages.id })
        .from(schema.stages)
        .where(
          and(
            eq(schema.stages.pipelineId, p.id),
            eq(schema.stages.kind, "open"),
            sql`${schema.stages.archivedAt} IS NULL`,
          ),
        )
        .orderBy(asc(schema.stages.position))
        .limit(1)
    : [];
  if (!p || !stage)
    throw new HttpError(409, "NO_PIPELINE", "LUME needs a pipeline with an open stage first.");
  return { pipelineId: p.id, stageId: stage.id };
}

/**
 * Back from Instagram's sign-in: signed and sealed with this instance's token, an Instagram hand-back, fresh, and
 * matching a connect this same admin started, once. The token is kept encrypted. Connecting the same account again
 * keeps its id, its conversations and its lead source; a first connect makes the source its leads come in under.
 */
export async function connectComplete(req: FastifyRequest, d: AppDeps, body: { p: string; s: string }) {
  await requireOn(req, d);
  const token = instagramRelayOf(d)!.relayToken;
  const invalid = () =>
    badRequest("CONNECT_INVALID", "This connection isn't valid. Try connecting the account again.");
  if (!verify(token, body.p, body.s)) throw invalid();
  const h = unseal<Handoff>(token, body.p);
  const ig = h?.instagram;
  if (
    !h ||
    h.kind !== "instagram" ||
    typeof h.nonce !== "string" ||
    !ig ||
    typeof ig.token !== "string" ||
    !/^\d{5,30}$/.test(ig.userId ?? "") ||
    typeof ig.username !== "string" ||
    !ig.username
  )
    throw invalid();
  if (h.exp < Date.now())
    throw badRequest("CONNECT_EXPIRED", "This connection took too long. Try connecting the account again.");
  const uid = req.actor!.userId;
  const [open] = await req.db
    .select({ id: OC.id })
    .from(OC)
    .where(
      and(
        eq(OC.nonceHash, sha256(h.nonce)),
        eq(OC.userId, uid),
        eq(OC.kind, "instagram"),
        isNull(OC.completedAt),
      ),
    )
    .for("update");
  if (!open)
    throw notFound("CONNECT_NOT_FOUND", "This connection was already used, or isn't yours. Try again.");
  await req.db.delete(OC).where(eq(OC.id, open.id));

  const [was] = await req.db.select().from(A).where(eq(A.igUserId, ig.userId)).for("update");
  const id = was?.id ?? newId();
  const now = new Date();
  // The account's lead source: kept across reconnects; made (or brought back from archived) here.
  let sourceId = was?.sourceId ?? null;
  const [src] = sourceId ? await req.db.select().from(S).where(eq(S.id, sourceId)) : [];
  if (!src) {
    const where = await firstStage(req);
    const [settings] = await req.db
      .select({ country: schema.settings.defaultCountryIso })
      .from(schema.settings)
      .where(eq(schema.settings.id, 1));
    const rules: Rules = {
      matchOn: ["instagram"],
      onMatch: "merge",
      reopenClosedTo: null,
      ...where,
      owner: { mode: "unassigned" },
      defaultCountry: settings?.country ?? null,
      noName: "use_contact",
      unknownOwner: "fallback",
      requiredDefaults: {},
    };
    sourceId = newId();
    await req.db.insert(S).values({
      id: sourceId,
      type: "instagram",
      name: `Instagram @${ig.username}`,
      status: "active",
      createdBy: uid,
      runAs: uid,
      rules,
    });
  } else
    await req.db
      .update(S)
      .set({ name: `Instagram @${ig.username}`, status: "active", archivedAt: null })
      .where(eq(S.id, src.id));

  const fields = {
    username: ig.username,
    name: ig.name,
    accountType: ig.accountType,
    runAs: uid,
    sourceId,
    tokenEnc: d.keyring.encrypt(ig.token, igTokenContext(id)),
    tokenAt: now,
    status: "active" as const,
    problem: null,
    updatedAt: now,
  };
  if (was)
    await req.db
      .update(A)
      .set({ ...fields, connectedAt: now })
      .where(eq(A.id, id));
  else await req.db.insert(A).values({ id, igUserId: ig.userId, ownerUserId: null, ...fields });
  await audit(req, {
    action: was ? "instagram.reconnected" : "instagram.connected",
    entityType: "instagram_account",
    entityId: id,
    diff: { username: ig.username },
  });
  return accountsView(req);
}

async function accountOf(req: FastifyRequest, id: string) {
  const [a] = await req.db
    .select()
    .from(A)
    .where(and(eq(A.id, id), ne(A.status, "disconnected")))
    .for("update");
  if (!a) throw notFound("ACCOUNT_NOT_FOUND", "That Instagram account isn't connected to LUME.");
  return a;
}

/** Whose account it is (a person: its conversations' notices come to them), and whether new people become leads. */
export async function setAccount(
  req: FastifyRequest,
  id: string,
  body: { ownerId?: string | null | undefined; newDmCreatesLead?: boolean | undefined },
) {
  const a = await accountOf(req, id);
  if (body.ownerId) {
    const [u] = await req.db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(and(eq(schema.users.id, body.ownerId), eq(schema.users.status, "active")));
    if (!u) throw badRequest("OWNER_INVALID", "Pick someone who uses LUME now.");
  }
  const set: Partial<typeof A.$inferInsert> = { updatedAt: new Date() };
  if (body.ownerId !== undefined) set.ownerUserId = body.ownerId;
  if (body.newDmCreatesLead !== undefined) set.newDmCreatesLead = body.newDmCreatesLead;
  await req.db.update(A).set(set).where(eq(A.id, a.id));
  await audit(req, {
    action: "instagram.updated",
    entityType: "instagram_account",
    entityId: a.id,
    diff: {
      ...(body.ownerId !== undefined ? { ownerId: { from: a.ownerUserId, to: body.ownerId } } : {}),
      ...(body.newDmCreatesLead !== undefined
        ? { newDmCreatesLead: { from: a.newDmCreatesLead, to: body.newDmCreatesLead } }
        : {}),
    },
  });
  return accountsView(req);
}

/** Tells the relay this LUME no longer holds the account (best effort: a missing route harms nothing). */
async function relayForget(d: AppDeps, accountIgId: string) {
  const relay = instagramRelayOf(d);
  if (!relay) return;
  await fetch(`${relay.relayUrl}/ig/forget`, {
    method: "POST",
    headers: { authorization: `Bearer ${relay.relayToken}`, "content-type": "application/json" },
    body: JSON.stringify({ accountId: accountIgId }),
    signal: AbortSignal.timeout(10_000),
  }).catch(() => null);
}

/** As widened for one statement, then put back: an account's strangers go whoever's they were. */
async function withAllScope(req: FastifyRequest, fn: () => Promise<unknown>) {
  const prev = await req.db.execute<{ s: string | null }>(
    sql`SELECT current_setting('lume.lead_scope', true) AS s`,
  );
  await req.db.execute(sql`SELECT set_config('lume.lead_scope', 'all', true)`);
  try {
    await fn();
  } finally {
    await req.db.execute(sql`SELECT set_config('lume.lead_scope', ${prev.rows[0]?.s ?? ""}, true)`);
  }
}

/**
 * Disconnect: Meta stops delivering (best effort: a token Meta already refuses can't unsubscribe, and the account goes
 * anyway), the relay forgets the route, the token is dropped, its Not a lead yet with it, and its lead source pauses.
 * What it brought to leads stays on them.
 */
export async function disconnect(req: FastifyRequest, d: AppDeps, id: string) {
  const a = await accountOf(req, id);
  if (a.tokenEnc)
    await igGraph(igGraphOf(d), d.keyring.decrypt(a.tokenEnc, igTokenContext(a.id)))
      .unsubscribe(a.igUserId)
      .then((r) => {
        if (!r.ok) req.log.warn({ status: r.status }, "Meta didn't unsubscribe an Instagram account");
      });
  await relayForget(d, a.igUserId);
  await withAllScope(req, () =>
    req.db
      .delete(schema.instagramThreads)
      .where(and(eq(schema.instagramThreads.accountId, a.id), isNull(schema.instagramThreads.leadId))),
  );
  await req.db
    .update(A)
    .set({ status: "disconnected", tokenEnc: null, problem: null, updatedAt: new Date() })
    .where(eq(A.id, a.id));
  if (a.sourceId) await req.db.update(S).set({ status: "paused" }).where(eq(S.id, a.sourceId));
  await audit(req, { action: "instagram.disconnected", entityType: "instagram_account", entityId: a.id });
  return accountsView(req);
}

/** Tells the admins once (a change of state, not each time it's seen): the caller only calls on the change. */
export async function tellAdmins(pool: pg.Pool, title: string, body: string) {
  for (const uid of await adminIds(pool))
    await notify(pool, uid, { kind: "system_alert", title, body, data: { href: "/settings/integrations" } });
}

/**
 * The relay says another LUME connected this account (a client moved servers): it stops here, its token goes, and the
 * admins hear once. Answers false for an account this LUME doesn't have connected.
 */
export async function accountMoved(pool: pg.Pool, accountIgId: string): Promise<boolean> {
  const { rows } = await pool.query<{ username: string }>(
    `UPDATE instagram_accounts SET status = 'disconnected', token_enc = NULL, updated_at = now(),
            problem = 'Connected to another LUME'
      WHERE ig_user_id = $1 AND status <> 'disconnected' RETURNING username`,
    [accountIgId],
  );
  const u = rows[0];
  if (!u) return false;
  await tellAdmins(
    pool,
    `Instagram @${u.username} was connected to another LUME`,
    "Its messages go there now. Connect it here again to bring them back.",
  );
  return true;
}

/** The accounts this LUME holds, for the relay's routing table. */
export async function heldAccounts(pool: pg.Pool): Promise<string[]> {
  const { rows } = await pool.query<{ id: string }>(
    "SELECT ig_user_id AS id FROM instagram_accounts WHERE status <> 'disconnected' ORDER BY ig_user_id",
  );
  return rows.map((r) => r.id);
}
