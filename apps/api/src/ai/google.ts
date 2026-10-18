import { GoogleGenAI } from "@google/genai";
import { AiUnreadable, parseAnswer, schemaForProvider, type AiProvider } from "./provider";

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
        model: o.model,
        contents: [{ role: "user", parts: [{ text: r.input }] }],
        config: {
          systemInstruction: r.instructions,
          responseMimeType: "application/json",
          responseJsonSchema: schemaForProvider(r.schema),
          maxOutputTokens: r.maxOutputTokens,
          abortSignal: r.signal,
        },
      });
      const text = res.text;
      if (!text)
        throw new AiUnreadable(`no answer (${res.candidates?.[0]?.finishReason ?? "nothing returned"})`);
      return {
        output: parseAnswer(text, r.schema),
        inputTokens: res.usageMetadata?.promptTokenCount ?? 0,
        outputTokens: res.usageMetadata?.candidatesTokenCount ?? 0,
      };
    },
  };
}
