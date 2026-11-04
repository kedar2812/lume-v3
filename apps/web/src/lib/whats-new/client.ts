"use client";
import type { StoryId, WhatsNewState } from "@lume/core/shared";
import { api } from "../api";

export type WhatsNewPatch = { seen?: string; used?: StoryId; pillGone?: string };

/**
 * What's new on the person's own record (PUT /me/whats-new): seen on one device is seen on all. A failed save never
 * interrupts the window or the tip: it answers null and the screen carries on.
 */
export const whatsNewClient = {
  async save(patch: WhatsNewPatch): Promise<WhatsNewState | null> {
    const r = await api.put<{ whatsNew: WhatsNewState }>("/api/v1/me/whats-new", patch);
    return r.ok ? r.data.whatsNew : null;
  },
};
