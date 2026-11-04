"use client";
import type { Story } from "@lume/core/shared";
import { AiGlyph } from "@/components/ai/AiGlyph";

const LABEL: Record<Story["kicker"], string> = { "lume-ai": "LUME AI", whatsapp: "WhatsApp", lume: "LUME" };
export const kickerLabel = (k: Story["kicker"]): string => LABEL[k];

/** A story's mark: the LUME AI Loop (alive), WhatsApp's official logo, or LUME's own, each as it is. */
export function StoryMark({ kicker, size = 18 }: { kicker: Story["kicker"]; size?: number }) {
  if (kicker === "lume-ai") return <AiGlyph size={size} draw="loop" />;
  if (kicker === "whatsapp") return <img src="/brand/whatsapp.svg" alt="" width={size} height={size} />;
  return <img src="/lume-mark.png" alt="" style={{ width: size, height: "auto" }} />;
}
