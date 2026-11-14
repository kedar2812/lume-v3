import { createHash, randomBytes } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { can, instanceIdOf, newId, sign, unseal, verify, type Handoff } from "@lume/core";
import { schema } from "@lume/db";
import type { AppDeps } from "../../app";
import { audit } from "../../audit/audit";
import { HttpError, badRequest, notFound } from "../../http/errors";
import { sheetsOn } from "../sheets/service";

/**
 * Live sheets (spec 2026-11-14 §2.4): a person connects a Google account through the relay, for live sheets only
 * (kind live_sheet, drive.file). The grant is theirs; a sheet that runs as someone else reads it with the sweep flag.
 */
const OC = schema.oauthConnects;
const G = schema.liveSheetGrants;
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export const grantContext = (id: string) => `live-sheet-grant:${id}`;

const notConfigured = () =>
  new HttpError(409, "NOT_CONFIGURED", "Connect with Google isn't set up on this server.");
const sheetsOff = () =>
  new HttpError(
    409,
    "SHEETS_OFF",
    "Google Sheets is switched off. An admin can switch it on in Settings → Integrations.",
  );
export const noExport = () =>
  new HttpError(
    403,
    "NO_EXPORT_ACCESS",
    "Live sheets take leads out of LUME, so they need Export leads too.",
  );

/** What every live sheet action needs beyond the permission: Export leads, Connect with Google and Google Sheets on. */
export async function requireLiveSheets(req: FastifyRequest, d: AppDeps): Promise<void> {
  if (!can(req.actor!, "leads.export")) throw noExport();
  if (!d.googleOAuth) throw notConfigured();
  if (!(await sheetsOn(req))) throw sheetsOff();
}

export async function liveSheetConnectStart(req: FastifyRequest, d: AppDeps): Promise<{ url: string }> {
  await requireLiveSheets(req, d);
  const { relayUrl, relayToken } = d.googleOAuth!;
  const nonce = randomBytes(24).toString("base64url");
  await req.db
    .insert(OC)
    .values({ id: newId(), userId: req.actor!.userId, nonceHash: sha256(nonce), kind: "live_sheet" });
  const url = new URL("/start", relayUrl);
  url.search = new URLSearchParams({
    i: instanceIdOf(relayToken),
    n: nonce,
    k: "live_sheet",
    s: sign(relayToken, `${nonce}.live_sheet`),
  }).toString();
  return { url: url.toString() };
}

export type GrantView = { id: string; email: string };

export async function liveSheetConnectComplete(
  req: FastifyRequest,
  d: AppDeps,
  body: { p: string; s: string },
): Promise<{ grant: GrantView }> {
  await requireLiveSheets(req, d);
  const token = d.googleOAuth!.relayToken;
  const invalid = () =>
    badRequest("CONNECT_INVALID", "This connection isn't valid. Try connecting Google again.");
  if (!verify(token, body.p, body.s)) throw invalid();
  const h = unseal<Handoff>(token, body.p);
  if (
    !h ||
    h.kind !== "live_sheet" ||
    typeof h.nonce !== "string" ||
    typeof h.refreshToken !== "string" ||
    typeof h.email !== "string"
  )
    throw invalid();
  if (h.exp < Date.now())
    throw badRequest("CONNECT_EXPIRED", "This connection took too long. Try connecting Google again.");
  const uid = req.actor!.userId;
  // Locked: two tabs completing the same hand-back at once; the second waits, then finds it used.
  const [open] = await req.db
    .select({ id: OC.id })
    .from(OC)
    .where(
      and(
        eq(OC.nonceHash, sha256(h.nonce)),
        eq(OC.userId, uid),
        eq(OC.kind, "live_sheet"),
        isNull(OC.completedAt),
      ),
    )
    .for("update");
  if (!open)
    throw notFound("CONNECT_NOT_FOUND", "This connection was already used, or isn't yours. Try again.");
  await req.db.delete(OC).where(eq(OC.id, open.id));
  const email = h.email.trim().toLowerCase();
  const [was] = await req.db
    .select({ id: G.id })
    .from(G)
    .where(and(eq(G.userId, uid), eq(G.googleEmail, email)))
    .for("update");
  const id = was?.id ?? newId();
  const grantEnc = d.keyring.encrypt(h.refreshToken, grantContext(id));
  if (was) await req.db.update(G).set({ grantEnc, updatedAt: new Date() }).where(eq(G.id, id));
  else await req.db.insert(G).values({ id, userId: uid, googleEmail: email, grantEnc });
  // A sheet paused because Google was disconnected picks up again with the renewed grant.
  if (was)
    await req.db
      .update(schema.liveSheets)
      .set({ status: "live", pauseReason: null, nextSyncAt: new Date(), failures: 0, updatedAt: new Date() })
      .where(
        and(
          eq(schema.liveSheets.grantId, id),
          eq(schema.liveSheets.pauseReason, "google_disconnected"),
          isNull(schema.liveSheets.deletedAt),
        ),
      );
  await audit(req, {
    action: "live_sheet.google_connected",
    entityType: "live_sheet_grant",
    entityId: id,
    diff: { email },
  });
  return { grant: { id, email } };
}

/** The person's own Google accounts for live sheets. */
export async function myGrants(req: FastifyRequest): Promise<{ grants: GrantView[] }> {
  const rows = await req.db
    .select({ id: G.id, email: G.googleEmail })
    .from(G)
    .where(eq(G.userId, req.actor!.userId))
    .orderBy(G.googleEmail);
  return { grants: rows };
}
