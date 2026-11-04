import type { ComponentType } from "react";
import type { StoryId } from "@lume/core/shared";

/** A story played in LUME's own components: `playing` runs its timeline; still, it shows its finished frame. */
export type DemoProps = { playing: boolean };

export const DEMOS: Partial<Record<StoryId, ComponentType<DemoProps>>> = {};
