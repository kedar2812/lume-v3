import { anthropicProvider } from "./anthropic";
import { fakeProvider } from "./fake";
import { googleProvider } from "./google";
import type { AiProvider } from "./provider";

/** The provider this server is set up for (`.env`), or null: no LUME AI here. */
export function providerFromConfig(cfg: {
  LUME_AI_PROVIDER?: "anthropic" | "google" | "fake" | undefined;
  LUME_AI_MODEL?: string | undefined;
  LUME_AI_KEY?: string | undefined;
}): AiProvider | null {
  switch (cfg.LUME_AI_PROVIDER) {
    case "anthropic":
      return anthropicProvider({ apiKey: cfg.LUME_AI_KEY!, model: cfg.LUME_AI_MODEL! });
    case "google":
      return googleProvider({ apiKey: cfg.LUME_AI_KEY!, model: cfg.LUME_AI_MODEL! });
    case "fake":
      return fakeProvider();
    default:
      return null;
  }
}
