import Anthropic from "@anthropic-ai/sdk";
import { AiUnreadable, parseAnswer, schemaForProvider, type AiProvider } from "./provider";

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
          model: o.model,
          max_tokens: r.maxOutputTokens,
          system: r.instructions,
          messages: [{ role: "user", content: r.input }],
          output_config: {
            effort: "low",
            format: { type: "json_schema", schema: schemaForProvider(r.schema) },
          },
        },
        { signal: r.signal },
      );
      if (res.stop_reason === "refusal") throw new AiUnreadable("the model declined");
      if (res.stop_reason === "max_tokens") throw new AiUnreadable("the answer was cut short");
      const text = res.content.map((b) => (b.type === "text" ? b.text : "")).join("");
      return {
        output: parseAnswer(text, r.schema),
        inputTokens: res.usage.input_tokens,
        outputTokens: res.usage.output_tokens,
      };
    },
  };
}
