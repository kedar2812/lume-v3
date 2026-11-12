import Anthropic from "@anthropic-ai/sdk";
import { AiUnreadable, parseAnswer, schemaForProvider, type AiProvider, type AiUsage } from "./provider";

/**
 * Claude through the Messages API with structured output (spec 2026-10-18 §2.1). Low effort: reading a note is a
 * short, well-specified job. One retry at most; the caller's signal bounds the whole read.
 */
export function anthropicProvider(o: { apiKey: string; model: string; baseURL?: string }): AiProvider {
  const client = new Anthropic({
    apiKey: o.apiKey,
    maxRetries: 1,
    ...(o.baseURL ? { baseURL: o.baseURL } : {}),
  });
  return {
    name: "anthropic",
    model: o.model,
    async read(r) {
      const res = await client.messages.create(
        {
          model: r.model ?? o.model,
          max_tokens: r.maxOutputTokens,
          // A cache breakpoint on the instructions (2026-11-12): the next read with the same instructions within five
          // minutes reads them at the cache's price. Instructions under the provider's minimum just aren't cached.
          system: [{ type: "text", text: r.instructions, cache_control: { type: "ephemeral" } }],
          messages: [{ role: "user", content: r.input }],
          output_config: {
            effort: "low",
            format: { type: "json_schema", schema: schemaForProvider(r.schema) },
          },
        },
        { signal: r.signal },
      );
      // Billed whatever comes next: an answer LUME can't use keeps what it cost (2026-11-12).
      const usage: AiUsage = {
        inputTokens: res.usage.input_tokens,
        outputTokens: res.usage.output_tokens,
        cacheWriteTokens: res.usage.cache_creation_input_tokens ?? 0,
        cacheReadTokens: res.usage.cache_read_input_tokens ?? 0,
      };
      if (res.stop_reason === "refusal") throw new AiUnreadable("the model declined", usage);
      if (res.stop_reason === "max_tokens") throw new AiUnreadable("the answer was cut short", usage);
      const text = res.content.map((b) => (b.type === "text" ? b.text : "")).join("");
      return { output: parseAnswer(text, r.schema, usage), ...usage };
    },
  };
}
