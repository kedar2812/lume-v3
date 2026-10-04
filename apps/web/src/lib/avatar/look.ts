import { AVATAR_COLORS, type AvatarColor } from "@lume/core/shared";

/** A person's look as the API gives it (7C): their colour key, and the photo's version when there is one. */
export type Look = { color: AvatarColor | null; version: number; photo: boolean };

/** The colour and photo address for someone's look; the address changes with every new photo. */
export function lookOf(id: string, look: Look | null | undefined): { color?: string; photo?: string } {
  if (!look) return {};
  return {
    ...(look.color ? { color: AVATAR_COLORS[look.color] } : {}),
    ...(look.photo ? { photo: `/api/v1/users/${id}/avatar?v=${look.version}` } : {}),
  };
}
