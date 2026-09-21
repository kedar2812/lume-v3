import { and, eq, inArray, isNull } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { newId } from "@lume/core";
import { schema } from "@lume/db";
import { audit } from "../../audit/audit";
import { badRequest, conflict, notFound } from "../../http/errors";
import { notifyRbac } from "../../rbac/notify";

async function team(req: FastifyRequest, id: string) {
  const [t] = await req.db
    .select()
    .from(schema.teams)
    .where(and(eq(schema.teams.id, id), isNull(schema.teams.deletedAt)));
  if (!t) throw notFound();
  return t;
}

export async function listTeams(req: FastifyRequest) {
  const teams = await req.db
    .select()
    .from(schema.teams)
    .where(isNull(schema.teams.deletedAt))
    .orderBy(schema.teams.name);
  const members = await req.db.select().from(schema.teamMembers);
  return {
    teams: teams.map((t) => ({
      id: t.id,
      name: t.name,
      members: members.filter((m) => m.teamId === t.id).map((m) => ({ userId: m.userId, isLead: m.isLead })),
    })),
  };
}

export async function createTeam(req: FastifyRequest, name: string) {
  const [dup] = await req.db
    .select({ id: schema.teams.id })
    .from(schema.teams)
    .where(and(eq(schema.teams.name, name), isNull(schema.teams.deletedAt)));
  if (dup) throw conflict("TEAM_EXISTS", "A team with that name already exists");
  const id = newId();
  await req.db.insert(schema.teams).values({ id, name });
  await audit(req, { action: "team.created", entityType: "team", entityId: id, diff: { name } });
  return { team: { id, name, members: [] } };
}

export async function renameTeam(req: FastifyRequest, id: string, name: string) {
  await team(req, id);
  await req.db.update(schema.teams).set({ name }).where(eq(schema.teams.id, id));
  await audit(req, { action: "team.renamed", entityType: "team", entityId: id, diff: { name } });
}

export async function deleteTeam(req: FastifyRequest, id: string) {
  await team(req, id);
  await req.db.delete(schema.teamMembers).where(eq(schema.teamMembers.teamId, id));
  await req.db.update(schema.teams).set({ deletedAt: new Date() }).where(eq(schema.teams.id, id));
  await notifyRbac(req);
  await audit(req, { action: "team.deleted", entityType: "team", entityId: id });
}

export async function setMembers(
  req: FastifyRequest,
  id: string,
  members: { userId: string; isLead: boolean }[],
) {
  await team(req, id);
  const ids = [...new Set(members.map((m) => m.userId))];
  if (ids.length !== members.length) throw badRequest("DUPLICATE_MEMBER", "Someone is listed twice");
  const found = ids.length
    ? await req.db.select({ id: schema.users.id }).from(schema.users).where(inArray(schema.users.id, ids))
    : [];
  if (found.length !== ids.length) throw badRequest("UNKNOWN_USER", "One of those people doesn't exist");
  await req.db.delete(schema.teamMembers).where(eq(schema.teamMembers.teamId, id));
  if (members.length)
    await req.db
      .insert(schema.teamMembers)
      .values(members.map((m) => ({ teamId: id, userId: m.userId, isLead: m.isLead })));
  await notifyRbac(req);
  await audit(req, { action: "team.members.set", entityType: "team", entityId: id, diff: { members } });
  return listTeams(req).then((r) => ({ team: r.teams.find((t) => t.id === id) }));
}
