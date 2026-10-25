import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { AppDeps } from "../../app";
import { sendable } from "../leads/sending";
import { ignorePeer, inboxPerson, inboxView, makeLead } from "./inbox";
import { KEEP_MONTHS, keepPreview } from "./keep";
import { fileNameOf } from "./keep-bytes";
import { archiveFile, deleteFile, listFiles, renameFile, setFileLink, uploadFile } from "./library";
import { mediaInfo, sendMedia } from "./media";
import { attachFile, attachLibraryFile, sendLimiter, sendReply } from "./send";
import { LIMITS } from "./sniff";
import { submissionsOf, submitTemplate } from "./submit";
import { sendTemplate, templateState } from "./template-send";
import { replyBoard } from "./replies";
import { leadThread } from "./thread";
import {
  connectComplete,
  connectStart,
  disconnect,
  numbersView,
  setOwner,
  setWhatsAppSettings,
} from "./service";

/** WhatsApp (spec 2026-10-18 §3): the module switch, connecting numbers and whose each is — admins only. */
export async function whatsappRoutes(app: FastifyInstance, d: AppDeps): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const manage = { config: { permission: "integrations.manage" as const } };
  const id = z.object({ id: z.uuid() });
  r.put(
    "/api/v1/integrations/whatsapp",
    {
      ...manage,
      schema: {
        body: z
          .object({
            enabled: z.boolean().optional(),
            keepFilesMonths: KEEP_MONTHS.optional(),
            replyFromLume: z.boolean().optional(),
          })
          .strict()
          .refine((b) => Object.values(b).some((v) => v !== undefined), "Nothing to change."),
      },
    },
    (req) => setWhatsAppSettings(req, d, req.body),
  );
  // How many files a shorter "keep for" would remove, for the sheet that asks first.
  r.get(
    "/api/v1/whatsapp/files/keep-preview",
    {
      ...manage,
      schema: { querystring: z.object({ months: z.coerce.number().pipe(KEEP_MONTHS.unwrap()) }).strict() },
    },
    (req) => keepPreview(d, req.query.months),
  );
  r.post("/api/v1/whatsapp/connect", manage, (req) => connectStart(req, d));
  r.post(
    "/api/v1/whatsapp/connect/complete",
    {
      ...manage,
      schema: { body: z.object({ p: z.string().min(1).max(8000), s: z.string().min(1).max(200) }).strict() },
    },
    (req) => connectComplete(req, d, req.body),
  );
  r.get("/api/v1/whatsapp/numbers", manage, (req) => numbersView(req));
  r.patch(
    "/api/v1/whatsapp/numbers/:id",
    { ...manage, schema: { params: id, body: z.object({ ownerId: z.uuid().nullable() }).strict() } },
    (req) => setOwner(req, req.params.id, req.body.ownerId),
  );
  r.delete("/api/v1/whatsapp/numbers/:id", { ...manage, schema: { params: id } }, (req) =>
    disconnect(req, d, req.params.id),
  );

  // A lead's WhatsApp thread, for the drawer (§4.2): seen with the lead.
  r.get(
    "/api/v1/leads/:id/whatsapp",
    { config: { permission: "leads.view" }, schema: { params: id } },
    (req) => leadThread(req, d, req.params.id),
  );
  // Who replied (W2, §4.2): each lead's latest reply since a moment, grouped by what it means (a week by default).
  r.get(
    "/api/v1/whatsapp/replies",
    {
      config: { permission: "leads.view" },
      schema: { querystring: z.object({ since: z.iso.datetime({ offset: true }).optional() }) },
    },
    (req) =>
      replyBoard(
        req,
        req.query.since ? new Date(req.query.since) : new Date(d.clock().getTime() - 7 * 86_400_000),
      ),
  );
  // Replying from LUME (plan W3a; spec §3.4): a message, and a file attached for one.
  const limiter = sendLimiter({ now: d.clock });
  r.post(
    "/api/v1/leads/:id/whatsapp/messages",
    {
      config: { permission: "messages.send" },
      schema: {
        params: id,
        body: z
          .object({
            clientKey: z.uuid(),
            // Checked in words by the service (4,096 with no file, 1,024 with one); this is only a ceiling.
            text: z.string().max(8192).optional(),
            mediaId: z.uuid().optional(),
            taskId: z.uuid().optional(),
          })
          .strict(),
      },
    },
    async (req, reply) => reply.code(202).send(await sendReply(req, d, limiter, req.params.id, req.body)),
  );
  // An approved template (W3b-2): what there is to send this lead, and sending one, outside the 24 hours too.
  r.get(
    "/api/v1/leads/:id/whatsapp/templates",
    { config: { permission: "messages.send" }, schema: { params: id } },
    async (req) => templateState(req, d, await sendable(req, req.params.id)),
  );
  r.post(
    "/api/v1/leads/:id/whatsapp/template",
    {
      config: { permission: "messages.send" },
      schema: { params: id, body: z.object({ submissionId: z.uuid(), clientKey: z.uuid() }).strict() },
    },
    async (req, reply) => reply.code(202).send(await sendTemplate(req, d, limiter, req.params.id, req.body)),
  );
  // A file from the business's library (W3b-1), attached with nothing uploaded again.
  r.post(
    "/api/v1/leads/:id/whatsapp/files/library",
    {
      config: { permission: "messages.send" },
      schema: { params: id, body: z.object({ fileId: z.uuid() }).strict() },
    },
    async (req, reply) =>
      reply.code(201).send(await attachLibraryFile(req, d, req.params.id, req.body.fileId)),
  );
  await r.register(async (files) => {
    // Scoped: only these routes take a raw body, at most a document's 25 MB (+1, so one byte over is refused in words).
    files.addContentTypeParser(
      "*",
      { parseAs: "buffer", bodyLimit: LIMITS.document + 1 },
      (_req, body, done) => done(null, body),
    );
    const bytesOf = (body: unknown) => (Buffer.isBuffer(body) ? body : Buffer.alloc(0));
    files.withTypeProvider<ZodTypeProvider>().post(
      "/api/v1/leads/:id/whatsapp/files",
      {
        config: { permission: "messages.send", idempotent: false },
        bodyLimit: LIMITS.document + 1,
        schema: { params: id },
      },
      async (req, reply) =>
        reply.code(201).send(await attachFile(req, d, req.params.id, bytesOf(req.body), fileNameOf(req))),
    );
    // The file library (W3b-1): a brochure or photo for the whole business, kept once.
    files.post(
      "/api/v1/files",
      { config: { permission: "templates.manage", idempotent: false }, bodyLimit: LIMITS.document + 1 },
      async (req, reply) =>
        reply.code(201).send(await uploadFile(req, d, bytesOf(req.body), fileNameOf(req))),
    );
  });
  // A template to WhatsApp for approval (W3b-2), and where it stands.
  r.post(
    "/api/v1/templates/:id/whatsapp",
    {
      config: { permission: "templates.manage", idempotent: false },
      schema: {
        params: id,
        body: z
          .object({
            language: z.string().regex(/^[a-z]{2,3}(_[A-Z]{2})?$/),
            category: z.enum(["MARKETING", "UTILITY"]).optional(),
            headerFileId: z.uuid().optional(),
          })
          .strict(),
      },
    },
    async (req, reply) => reply.code(202).send(await submitTemplate(req, d, req.params.id, req.body)),
  );
  r.get(
    "/api/v1/templates/:id/whatsapp",
    { config: { permission: "templates.use" }, schema: { params: id } },
    (req) => submissionsOf(req, d, req.params.id),
  );
  const fileId = z.object({ id: z.uuid() });
  r.get(
    "/api/v1/files",
    {
      config: { permission: "templates.use" },
      schema: { querystring: z.object({ archived: z.literal("1").optional() }) },
    },
    (req) => listFiles(req, d, req.query.archived === "1"),
  );
  r.patch(
    "/api/v1/files/:id",
    {
      config: { permission: "templates.manage" },
      schema: { params: fileId, body: z.object({ name: z.string().trim().min(1).max(120) }).strict() },
    },
    (req) => renameFile(req, d, req.params.id, req.body.name),
  );
  r.post(
    "/api/v1/files/:id/archive",
    { config: { permission: "templates.manage" }, schema: { params: fileId } },
    (req) => archiveFile(req, d, req.params.id, true),
  );
  // Deleted for good (owner, 2026-10-25), from Media's confirm; archive is the gentler way and stays.
  r.delete(
    "/api/v1/files/:id",
    { config: { permission: "templates.manage" }, schema: { params: fileId } },
    async (req, reply) => {
      await deleteFile(req, req.params.id);
      return reply.code(204).send();
    },
  );
  r.post(
    "/api/v1/files/:id/restore",
    { config: { permission: "templates.manage" }, schema: { params: fileId } },
    (req) => archiveFile(req, d, req.params.id, false),
  );
  r.put(
    "/api/v1/files/:id/link",
    {
      config: { permission: "templates.manage" },
      schema: { params: fileId, body: z.object({ on: z.boolean() }).strict() },
    },
    (req) => setFileLink(req, d, req.params.id, req.body.on),
  );
  // A file on a lead, or waiting in Not a lead yet: row-level security decides who sees it (§4.1).
  r.get(
    "/api/v1/whatsapp/media/:id",
    { config: { permission: "leads.view" }, schema: { params: id } },
    (req, reply) => sendMedia(req, reply, d, req.params.id),
  );
  r.get(
    "/api/v1/whatsapp/media/:id/info",
    { config: { permission: "leads.view" }, schema: { params: id } },
    (req) => mediaInfo(req, d, req.params.id),
  );
  // Not a lead yet (§4.1): the number's owner and whoever sees every lead (row-level security decides).
  const person = z.object({ numberId: z.uuid(), peer: z.string().regex(/^\+\d{6,16}$/) });
  r.get("/api/v1/whatsapp/inbox", { config: { permission: "auth.self" } }, (req) => inboxView(req));
  r.get(
    "/api/v1/whatsapp/inbox/:numberId/:peer",
    { config: { permission: "auth.self" }, schema: { params: person } },
    (req) => inboxPerson(req, req.params.numberId, req.params.peer),
  );
  r.post(
    "/api/v1/whatsapp/inbox/:numberId/:peer/lead",
    { config: { permission: "leads.create" }, schema: { params: person } },
    async (req, reply) => reply.code(201).send(await makeLead(req, req.params.numberId, req.params.peer)),
  );
  r.post(
    "/api/v1/whatsapp/inbox/:numberId/:peer/ignore",
    { config: { permission: "auth.self" }, schema: { params: person } },
    (req) => ignorePeer(req, req.params.numberId, req.params.peer),
  );
}
