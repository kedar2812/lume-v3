import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { CHAT_LIMITS } from "@lume/core";
import {
  changeChannel,
  channelsToManage,
  chatList,
  chatOne,
  chatPeople,
  chatUnread,
  convOf,
  leadThread,
  makeChannel,
  setChannelMembers,
  setFold,
  setMute,
  startDirect,
  tell,
} from "./conversations";
import { deleteMessage, delivered, editMessage, messagesOf, react, read, sendMessage } from "./messages";
import { typingAllowed } from "./live";

/** Team Chat 2A (plan 2026-11-24-team-chat-2a, Tasks 3 and 4): everyone who chats; channels for whoever manages them. */
export async function chatRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const use = { config: { permission: "chat.use" as const } };
  // The same done twice is the same (marks, typing, reactions): no row kept to remember it by.
  const light = { config: { permission: "chat.use" as const, idempotent: false } };
  const manage = { config: { permission: "chat.channels.manage" as const } };
  const id = z.object({ id: z.uuid() });
  const mid = z.object({ mid: z.coerce.number().int().positive() });
  const people = z.array(z.uuid()).max(5000);
  const group = z.object({ kind: z.enum(["everyone", "team", "role"]), id: z.uuid().optional() }).strict();
  // Long enough to say why it's too long (the rules say it in words), short enough never to be a burden.
  const words = z.string().max(CHAT_LIMITS.body * 4);

  r.get("/api/v1/chat", use, (req) => chatList(req));
  r.get("/api/v1/chat/unread", use, (req) => chatUnread(req));
  r.get("/api/v1/chat/people", use, (req) => chatPeople(req));
  r.get("/api/v1/chat/channels", manage, (req) => channelsToManage(req));
  r.get("/api/v1/chat/:id", { ...use, schema: { params: id } }, (req) => chatOne(req, req.params.id));
  r.put(
    "/api/v1/chat/folds",
    {
      ...light,
      schema: {
        body: z.object({ list: z.enum(["channels", "direct", "leads"]), folded: z.boolean() }).strict(),
      },
    },
    async (req, reply) => {
      await setFold(req, req.body.list, req.body.folded);
      return reply.code(204).send();
    },
  );
  r.post(
    "/api/v1/chat/channels",
    {
      ...manage,
      schema: {
        body: z
          .object({
            name: z.string().max(200),
            topic: z.string().max(CHAT_LIMITS.topic).optional(),
            people: people.optional(),
            groups: z.array(group).max(50).optional(),
          })
          .strict(),
      },
    },
    async (req, reply) => reply.code(201).send(await makeChannel(req, req.body)),
  );
  r.patch(
    "/api/v1/chat/channels/:id",
    {
      ...manage,
      schema: {
        params: id,
        body: z
          .object({
            name: z.string().max(200).optional(),
            topic: z.string().max(CHAT_LIMITS.topic).optional(),
            archived: z.boolean().optional(),
          })
          .strict(),
      },
    },
    (req) => changeChannel(req, req.params.id, req.body),
  );
  r.put(
    "/api/v1/chat/channels/:id/members",
    {
      ...manage,
      schema: { params: id, body: z.object({ people, groups: z.array(group).max(50) }).strict() },
    },
    (req) => setChannelMembers(req, req.params.id, req.body),
  );
  r.post(
    "/api/v1/chat/direct",
    { ...use, schema: { body: z.object({ people: z.array(z.uuid()).max(50) }).strict() } },
    (req) => startDirect(req, req.body.people),
  );
  r.post(
    "/api/v1/chat/leads/:leadId",
    { ...use, schema: { params: z.object({ leadId: z.uuid() }) } },
    (req) => leadThread(req, req.params.leadId),
  );
  r.put(
    "/api/v1/chat/:id/mute",
    { ...light, schema: { params: id, body: z.object({ muted: z.boolean() }).strict() } },
    async (req, reply) => {
      await setMute(req, req.params.id, req.body.muted);
      return reply.code(204).send();
    },
  );

  r.get(
    "/api/v1/chat/:id/messages",
    {
      ...use,
      schema: {
        params: id,
        querystring: z
          .object({
            before: z.coerce.number().int().positive().optional(),
            after: z.coerce.number().int().min(0).optional(),
          })
          .strict(),
      },
    },
    (req) => messagesOf(req, req.params.id, req.query),
  );
  r.post(
    "/api/v1/chat/:id/messages",
    {
      config: { permission: "chat.use" as const, idempotent: false },
      schema: {
        params: id,
        body: z
          .object({
            clientId: z.uuid(),
            body: words.optional(),
            replyTo: z.number().int().positive().optional(),
            files: z.array(z.uuid()).max(50).optional(),
          })
          .strict(),
      },
    },
    async (req, reply) => {
      const r2 = await sendMessage(req, req.params.id, req.body);
      return reply.code(r2.created ? 201 : 200).send(r2.message);
    },
  );
  r.patch(
    "/api/v1/chat/messages/:mid",
    { ...use, schema: { params: mid, body: z.object({ body: words }).strict() } },
    (req) => editMessage(req, req.params.mid, req.body.body),
  );
  r.delete("/api/v1/chat/messages/:mid", { ...use, schema: { params: mid } }, async (req, reply) => {
    await deleteMessage(req, req.params.mid);
    return reply.code(204).send();
  });
  const reaction = mid.extend({ emoji: z.string().max(64) });
  r.put(
    "/api/v1/chat/messages/:mid/reactions/:emoji",
    { ...light, schema: { params: reaction } },
    async (req, reply) => {
      await react(req, req.params.mid, req.params.emoji, true);
      return reply.code(204).send();
    },
  );
  r.delete(
    "/api/v1/chat/messages/:mid/reactions/:emoji",
    { ...light, schema: { params: reaction } },
    async (req, reply) => {
      await react(req, req.params.mid, req.params.emoji, false);
      return reply.code(204).send();
    },
  );
  // Typing: said to the others at most once every 3 s, never written (plan Task 6).
  r.post("/api/v1/chat/:id/typing", { ...light, schema: { params: id } }, async (req, reply) => {
    await convOf(req, req.params.id);
    if (typingAllowed(req.actor!.userId, req.params.id))
      await tell(req, { c: req.params.id, e: "typing", u: req.actor!.userId });
    return reply.code(204).send();
  });
  const upTo = z.object({ upTo: z.number().int().min(0) }).strict();
  r.put("/api/v1/chat/:id/read", { ...light, schema: { params: id, body: upTo } }, async (req, reply) => {
    await read(req, req.params.id, req.body.upTo);
    return reply.code(204).send();
  });
  r.put(
    "/api/v1/chat/:id/delivered",
    { ...light, schema: { params: id, body: upTo } },
    async (req, reply) => {
      await delivered(req, req.params.id, req.body.upTo);
      return reply.code(204).send();
    },
  );
}
