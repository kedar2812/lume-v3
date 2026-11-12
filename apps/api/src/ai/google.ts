import { GoogleGenAI } from "@google/genai";
import { AiUnreadable, parseAnswer, schemaForProvider, type AiProvider, type AiUsage } from "./provider";

/** Gemini through generateContent with a JSON response schema (spec 2026-10-18 §2.1). */
export function googleProvider(o: { apiKey: string; model: string; baseURL?: string }): AiProvider {
  const ai = new GoogleGenAI({
    apiKey: o.apiKey,
    ...(o.baseURL ? { httpOptions: { baseUrl: o.baseURL } } : {}),
  });
  return {
    name: "google",
    model: o.model,
    async read(r) {
      const res = await ai.models.generateContent({
        model: r.model ?? o.model,
        contents: [{ role: "user", parts: [{ text: r.input }] }],
        config: {
          systemInstruction: r.instructions,
          responseMimeType: "application/json",
          responseJsonSchema: schemaForProvider(r.schema),
          maxOutputTokens: r.maxOutputTokens,
          abortSignal: r.signal,
        },
      });
      // Gemini's prompt count includes what came from its cache, and its candidates leave out thinking, which is
      // billed as output (2026-11-12).
      const m = res.usageMetadata;
      const cached = m?.cachedContentTokenCount ?? 0;
      const usage: AiUsage = {
        inputTokens: Math.max(0, (m?.promptTokenCount ?? 0) - cached),
        outputTokens: (m?.candidatesTokenCount ?? 0) + (m?.thoughtsTokenCount ?? 0),
        cacheWriteTokens: 0,
        cacheReadTokens: cached,
      };
      const text = res.text;
      if (!text)
        throw new AiUnreadable(
          `no answer (${res.candidates?.[0]?.finishReason ?? "nothing returned"})`,
          usage,
        );
      return { output: parseAnswer(text, r.schema, usage), ...usage };
    },
  };
}
