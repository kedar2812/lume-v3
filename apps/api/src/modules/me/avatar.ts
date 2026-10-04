import { eq, sql } from "drizzle-orm";
import type { FastifyReply, FastifyRequest } from "fastify";
import { checkAvatarImage, type AvatarColor } from "@lume/core";
import { schema } from "@lume/db";
import { audit } from "../../audit/audit";
import { HttpError, notFound } from "../../http/errors";

/** A person's look as everyone else reads it: the colour, and the photo's version (null = no photo). */
export type AvatarView = { color: AvatarColor | null; version: number; photo: boolean };

/**
 * Change your own look (7C, canvas Profile): a colour for your initials, a photo (the browser's 256 px crop, checked
 * byte by byte before it's kept), or the photo removed. Each change moves the version on, so every cached copy of
 * the old photo is passed over.
 */
export async function setAvatar(
  req: FastifyRequest,
  patch: { color?: AvatarColor | null; image?: string | null },
): Promise<AvatarView> {
  const me = req.actor!.userId;
  let photo: { bytes: Buffer; type: "image/webp" | "image/jpeg" } | null | undefined;
  if (typeof patch.image === "string") {
    const bytes = Buffer.from(patch.image, "base64");
    const check = checkAvatarImage(bytes);
    if (!check.ok)
      throw new HttpError(
        422,
        "AVATAR_REFUSED",
        `LUME keeps a 256 × 256 photo and nothing else with it. This one has ${check.reason}. Choose it again, then save.`,
      );
    photo = { bytes, type: check.type };
  } else if (patch.image === null) photo = null;

  if (photo)
    await req.db
      .insert(schema.userAvatars)
      .values({ userId: me, image: photo.bytes, type: photo.type, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: schema.userAvatars.userId,
        set: { image: photo.bytes, type: photo.type, updatedAt: new Date() },
      });
  else if (photo === null) await req.db.delete(schema.userAvatars).where(eq(schema.userAvatars.userId, me));

  const [u] = await req.db
    .update(schema.users)
    .set({
      ...(patch.color !== undefined ? { avatarColor: patch.color } : {}),
      avatarVersion: sql`${schema.users.avatarVersion} + 1`,
    })
    .where(eq(schema.users.id, me))
    .returning({ color: schema.users.avatarColor, version: schema.users.avatarVersion });
  const [has] = await req.db
    .select({ userId: schema.userAvatars.userId })
    .from(schema.userAvatars)
    .where(eq(schema.userAvatars.userId, me));
  await audit(req, {
    action: "user.avatar.updated",
    entityType: "user",
    entityId: me,
    diff: {
      fields: [
        ...(patch.color !== undefined ? ["color"] : []),
        ...(photo ? ["photo"] : photo === null ? ["photo removed"] : []),
      ],
    },
  });
  return { color: u!.color ?? null, version: u!.version, photo: !!has };
}

/**
 * Someone's photo, for anyone signed in (the people they work with see it beside their name). The address carries
 * the version, so it can be kept for good; served as the image it was checked to be, and nothing else.
 */
export async function sendAvatar(req: FastifyRequest, reply: FastifyReply, userId: string) {
  const [row] = await req.db
    .select({ image: schema.userAvatars.image, type: schema.userAvatars.type })
    .from(schema.userAvatars)
    .where(eq(schema.userAvatars.userId, userId));
  if (!row) throw notFound("NO_PHOTO", "No photo");
  return reply
    .header("content-type", row.type)
    .header("cache-control", "private, max-age=31536000, immutable")
    .header("x-content-type-options", "nosniff")
    .header("content-security-policy", "default-src 'none'")
    .send(row.image);
}
