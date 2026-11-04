import type { ComponentType } from "react";
import type { StoryId } from "@lume/core/shared";
import { CallsDemo } from "./CallsDemo";
import { ChatsDemo } from "./ChatsDemo";
import { TemplatesDemo } from "./TemplatesDemo";

/** A story played in LUME's own components: `playing` runs its timeline; still, it shows its finished frame. */
export type DemoProps = { playing: boolean };

export const DEMOS: Record<StoryId, ComponentType<DemoProps>> = {
  calls: CallsDemo,
  chats: ChatsDemo,
  templates: TemplatesDemo,
};
