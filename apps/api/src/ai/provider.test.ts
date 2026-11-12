import http from "node:http";
import type { AddressInfo } from "node:net";
import {
  autopilotFirstOutput,
  autopilotReplyOutput,
  catchUpOutput,
  nextStepOutput,
  replyMeaningOutput,
  type LeadFacts,
} from "@lume/core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { anthropicProvider } from "./anthropic";
import { fakeProvider } from "./fake";
import { googleProvider } from "./google";
import { aiFromConfig, providerFromConfig } from "./from-config";
import { AiUnreadable, schemaForProvider } from "./provider";

/** LUME AI's plug (spec 2026-10-18 §2.1): each adapter against a stand-in for its provider's API. */
type Seen = { path: string; headers: http.IncomingHttpHeaders; body: Record<string, unknown> };
let seen: Seen[] = [];
let reply: (path: string) => { status: number; body: unknown; delayMs?: number };
let server: http.Server;
let base = "";

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c: Buffer) => (raw += c.toString("utf8")));
    req.on("end", () => {
      seen.push({
        path: req.url ?? "",
        headers: req.headers,
        body: JSON.parse(raw || "{}") as Record<string, unknown>,
      });
      const r = reply(req.url ?? "");
      setTimeout(() => {
        res.writeHead(r.status, { "content-type": "application/json" });
        res.end(JSON.stringify(r.body));
      }, r.delayMs ?? 0);
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((done) => server.close(() => done())));
beforeEach(() => {
  seen = [];
});

const answer = {
  summary: "Wants a site visit on Saturday.",
  stageId: "s-visit",
  followUp: { at: "2026-10-24T11:00", title: "Site visit" },
  lostReasonId: null,
  tagIds: [],
  decisionMaker: "her husband",
};
const ask = (signal = AbortSignal.timeout(5_000)) => ({
  instructions: "Rules.",
  input: '{"lead":{}}\n\nThe note:\nCall me Saturday.',
  schema: nextStepOutput,
  maxOutputTokens: 800,
  signal,
});
const claude = (text: string, stop = "end_turn") => ({
  id: "msg_1",
  type: "message",
  role: "assistant",
  model: "claude-test",
  content: [{ type: "text", text }],
  stop_reason: stop,
  stop_sequence: null,
  usage: { input_tokens: 412, output_tokens: 57 },
});
const gemini = (text: string) => ({
  candidates: [{ content: { role: "model", parts: [{ text }] }, finishReason: "STOP" }],
  usageMetadata: { promptTokenCount: 398, candidatesTokenCount: 61, totalTokenCount: 459 },
});

describe("the schema a provider is sent", () => {
  it("is plain JSON schema, every key required and no others, without the limits zod checks afterwards", () => {
    const s = schemaForProvider(nextStepOutput) as Record<string, unknown>;
    const text = JSON.stringify(s);
    expect(s).toMatchObject({ type: "object", additionalProperties: false });
    expect(s.required).toEqual(["summary", "stageId", "followUp", "lostReasonId", "tagIds", "decisionMaker"]);
    expect(text).not.toMatch(/maxLength|minLength|maxItems|\$schema/);
    // Which explanations may be shortened is LUME's own business, never sent to the provider.
    expect(text).not.toMatch(/soft|clip|fit/i);
    const c = JSON.stringify(schemaForProvider(catchUpOutput));
    expect(c).not.toMatch(/prefixItems/);
  });

  it("every answer LUME AI is asked for is closed: each object lists its keys and allows no others (review 2026-10-26 A9)", () => {
    // Anthropic's structured outputs refuse an open map: a reply's fields as {key: value} failed every read.
    const open: string[] = [];
    const walk = (v: unknown, at: string) => {
      if (Array.isArray(v)) return v.forEach((x, i) => walk(x, `${at}[${i}]`));
      if (!v || typeof v !== "object") return;
      const o = v as Record<string, unknown>;
      if (o.type === "object" && o.additionalProperties !== false) open.push(at);
      for (const [k, x] of Object.entries(o)) walk(x, `${at}.${k}`);
    };
    const tasks = {
      nextStepOutput,
      catchUpOutput,
      autopilotFirstOutput,
      autopilotReplyOutput,
      replyMeaningOutput,
    };
    for (const [name, schema] of Object.entries(tasks)) walk(schemaForProvider(schema), name);
    expect(open).toEqual([]);
  });
});

describe("Anthropic (Claude)", () => {
  it("sends the instructions, the input and the schema, and reads the JSON back", async () => {
    reply = () => ({ status: 200, body: claude(JSON.stringify(answer)) });
    const p = anthropicProvider({ apiKey: "sk-test-key-000000000000", model: "claude-test", baseURL: base });
    const r = await p.read(ask());
    expect(r).toEqual({
      output: answer,
      inputTokens: 412,
      outputTokens: 57,
      cacheWriteTokens: 0,
      cacheReadTokens: 0,
    });
    expect(seen[0]!.path).toBe("/v1/messages");
    expect(seen[0]!.headers["x-api-key"]).toBe("sk-test-key-000000000000");
    const b = seen[0]!.body;
    // The instructions carry a cache breakpoint (2026-11-12): the next read with the same ones reads them from the cache.
    expect(b).toMatchObject({
      model: "claude-test",
      max_tokens: 800,
      system: [{ type: "text", text: "Rules.", cache_control: { type: "ephemeral" } }],
    });
    expect(b.messages).toEqual([{ role: "user", content: '{"lead":{}}\n\nThe note:\nCall me Saturday.' }]);
    expect(b.output_config).toMatchObject({ format: { type: "json_schema" } });
    expect(JSON.stringify(b.output_config)).toContain('"summary"');
  });

  it("an answer that doesn't match the schema, or a refusal, is AiUnreadable", async () => {
    const p = anthropicProvider({ apiKey: "sk-test-key-000000000000", model: "claude-test", baseURL: base });
    reply = () => ({ status: 200, body: claude(JSON.stringify({ ...answer, summary: 7 })) });
    await expect(p.read(ask())).rejects.toBeInstanceOf(AiUnreadable);
    reply = () => ({ status: 200, body: claude("not json") });
    await expect(p.read(ask())).rejects.toBeInstanceOf(AiUnreadable);
    reply = () => ({ status: 200, body: claude("", "refusal") });
    await expect(p.read(ask())).rejects.toBeInstanceOf(AiUnreadable);
  });

  it("an answer LUME can't use was still billed: AiUnreadable carries what it cost (2026-11-12)", async () => {
    const p = anthropicProvider({ apiKey: "sk-test-key-000000000000", model: "claude-test", baseURL: base });
    const cut = claude('{"summary":"Wants a vis', "max_tokens");
    for (const body of [
      claude(JSON.stringify({ ...answer, summary: 7 })),
      claude("not json"),
      claude("", "refusal"),
      cut,
    ]) {
      reply = () => ({ status: 200, body });
      const e = await p.read(ask()).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(AiUnreadable);
      expect((e as AiUnreadable).usage).toEqual({
        inputTokens: 412,
        outputTokens: 57,
        cacheWriteTokens: 0,
        cacheReadTokens: 0,
      });
    }
  });

  it("a request the provider turned away has no usage: nothing was billed", async () => {
    reply = () => ({
      status: 400,
      body: { type: "error", error: { type: "invalid_request_error", message: "no" } },
    });
    const p = anthropicProvider({ apiKey: "sk-test-key-000000000000", model: "claude-test", baseURL: base });
    const e = await p.read(ask()).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(Error);
    expect(e).not.toBeInstanceOf(AiUnreadable);
  });

  it("an explanation a little past its limit is shortened, not thrown away (eval 2026-10-31)", async () => {
    const p = anthropicProvider({ apiKey: "sk-test-key-000000000000", model: "claude-test", baseURL: base });
    const summary =
      "She liked the 3D design and wants the quote revised for a smaller island before she decides, ".repeat(
        2,
      );
    reply = () => ({ status: 200, body: claude(JSON.stringify({ ...answer, summary })) });
    const r = await p.read(ask());
    const got = (r.output as { summary: string }).summary;
    expect(got.length).toBeLessThanOrEqual(140);
    expect(got.endsWith("…")).toBe(true);
    expect(summary.startsWith(got.slice(0, -1).trimEnd())).toBe(true);
  });

  it("what the cache wrote and read is kept apart from the input (2026-11-12)", async () => {
    reply = () => ({
      status: 200,
      body: {
        ...claude(JSON.stringify(answer)),
        usage: {
          input_tokens: 300,
          output_tokens: 57,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 2087,
        },
      },
    });
    const p = anthropicProvider({ apiKey: "sk-test-key-000000000000", model: "claude-test", baseURL: base });
    expect(await p.read(ask())).toMatchObject({
      inputTokens: 300,
      outputTokens: 57,
      cacheWriteTokens: 0,
      cacheReadTokens: 2087,
    });
  });

  it("a read on another model (a model per action, 2026-11-12) is sent to that model", async () => {
    reply = () => ({ status: 200, body: claude(JSON.stringify(answer)) });
    const p = anthropicProvider({ apiKey: "sk-test-key-000000000000", model: "claude-test", baseURL: base });
    await p.read({ ...ask(), model: "claude-light" });
    expect(seen[0]!.body).toMatchObject({ model: "claude-light" });
    await p.read(ask());
    expect(seen[1]!.body).toMatchObject({ model: "claude-test" });
  });

  it("an aborted read rejects, and is not AiUnreadable", async () => {
    reply = () => ({ status: 200, body: claude(JSON.stringify(answer)), delayMs: 2_000 });
    const p = anthropicProvider({ apiKey: "sk-test-key-000000000000", model: "claude-test", baseURL: base });
    const e = await p.read(ask(AbortSignal.timeout(50))).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(Error);
    expect(e).not.toBeInstanceOf(AiUnreadable);
  });
});

describe("Google (Gemini)", () => {
  it("sends the instructions, the input and the schema, and reads the JSON back", async () => {
    reply = () => ({ status: 200, body: gemini(JSON.stringify(answer)) });
    const p = googleProvider({ apiKey: "g-test-key-0000000000000", model: "gemini-test", baseURL: base });
    const r = await p.read(ask());
    expect(r).toEqual({
      output: answer,
      inputTokens: 398,
      outputTokens: 61,
      cacheWriteTokens: 0,
      cacheReadTokens: 0,
    });
    expect(seen[0]!.path).toMatch(/\/models\/gemini-test:generateContent$/);
    const b = seen[0]!.body as {
      contents: { parts: { text: string }[] }[];
      systemInstruction: { parts: { text: string }[] };
      generationConfig: Record<string, unknown>;
    };
    expect(b.systemInstruction.parts[0]!.text).toBe("Rules.");
    expect(b.contents[0]!.parts[0]!.text).toContain("Call me Saturday.");
    expect(b.generationConfig).toMatchObject({ responseMimeType: "application/json", maxOutputTokens: 800 });
    expect(JSON.stringify(b.generationConfig.responseJsonSchema)).toContain('"summary"');
  });

  it("thinking is billed as output, and what came from Gemini's cache is apart from the input (2026-11-12)", async () => {
    reply = () => ({
      status: 200,
      body: {
        ...gemini(JSON.stringify(answer)),
        usageMetadata: {
          promptTokenCount: 1_000,
          cachedContentTokenCount: 600,
          candidatesTokenCount: 61,
          thoughtsTokenCount: 140,
          totalTokenCount: 1_201,
        },
      },
    });
    const p = googleProvider({ apiKey: "g-test-key-0000000000000", model: "gemini-test", baseURL: base });
    const r = await p.read(ask());
    expect(r).toMatchObject({
      inputTokens: 400,
      outputTokens: 201,
      cacheWriteTokens: 0,
      cacheReadTokens: 600,
    });
  });

  it("a read on another model goes to that model", async () => {
    reply = () => ({ status: 200, body: gemini(JSON.stringify(answer)) });
    const p = googleProvider({ apiKey: "g-test-key-0000000000000", model: "gemini-test", baseURL: base });
    await p.read({ ...ask(), model: "gemini-light" });
    expect(seen[0]!.path).toMatch(/\/models\/gemini-light:generateContent$/);
  });

  it("an answer that doesn't match the schema is AiUnreadable, with what it cost", async () => {
    reply = () => ({ status: 200, body: gemini('{"summary":true}') });
    const p = googleProvider({ apiKey: "g-test-key-0000000000000", model: "gemini-test", baseURL: base });
    const e = await p.read(ask()).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(AiUnreadable);
    expect((e as AiUnreadable).usage).toEqual({
      inputTokens: 398,
      outputTokens: 61,
      cacheWriteTokens: 0,
      cacheReadTokens: 0,
    });
  });
});

describe("the fake (tests and e2e)", () => {
  const facts: LeadFacts = {
    firstName: "Sneha",
    stage: { id: "s-new", name: "New enquiry" },
    stages: [
      { id: "s-new", name: "New enquiry", kind: "open" },
      { id: "s-visit", name: "Site visit booked", kind: "open" },
      { id: "s-lost", name: "Lost", kind: "lost" },
    ],
    lostReasons: [],
    tags: [],
    fields: [],
    history: [],
    timezone: "Asia/Kolkata",
    now: "2026-10-18T06:00:00.000Z",
  };
  it("suggests the next open stage and tomorrow at 11:00 on the business's clock, and remembers what it read", async () => {
    const p = fakeProvider();
    const r = await p.read({
      ...ask(),
      input: `${JSON.stringify({ task: "next_step", lead: facts })}\n\nThe note:\nok`,
    });
    expect(r.output).toMatchObject({ stageId: "s-visit", followUp: { at: "2026-10-19T11:00" } });
    expect(p.calls).toHaveLength(1);
    expect(p.calls[0]!.input).toContain("The note:\nok");
  });
  it("answers a catch-up with three lines, or what a test gave it", async () => {
    const r = await fakeProvider().read({
      ...ask(),
      schema: catchUpOutput,
      input: JSON.stringify({ lead: facts }),
    });
    expect((r.output as { lines: string[] }).lines).toHaveLength(3);
    const given = fakeProvider({ next_step: { ...answer, stageId: null } });
    expect((await given.read(ask())).output).toMatchObject({ stageId: null });
  });

  it("Autopilot (A2): the first template offered, a plain reply, or what a test scripted, in order", async () => {
    const T = "0192c000-0000-7000-8000-000000000007";
    const p = fakeProvider();
    const first = await p.read({
      ...ask(),
      schema: autopilotFirstOutput,
      input: JSON.stringify({
        task: "autopilot_first",
        templates: [{ id: T, name: "First hello", body: "Hi" }],
      }),
    });
    expect(first.output).toEqual({ templateId: T, why: "The first approved template offered." });
    const plain = await p.read({ ...ask(), schema: autopilotReplyOutput, input: "{}" });
    expect(plain.output).toMatchObject({ kind: "reply", message: "Thanks for your message! Happy to help." });

    p.script("autopilot_reply", [
      {
        kind: "stop",
        message: null,
        reason: "Said stop",
        evidence: "stop",
        fileIds: [],
        stageId: null,
        fields: [],
        followUp: null,
        lostReasonId: null,
      },
    ]);
    expect((await p.read({ ...ask(), schema: autopilotReplyOutput, input: "{}" })).output).toMatchObject({
      kind: "stop",
    });
    // A script is used up in order; then the plain answer again.
    expect((await p.read({ ...ask(), schema: autopilotReplyOutput, input: "{}" })).output).toMatchObject({
      kind: "reply",
    });
  });
});

describe("providerFromConfig", () => {
  it("is null without a provider, and the named one otherwise", () => {
    expect(providerFromConfig({})).toBeNull();
    expect(providerFromConfig({ LUME_AI_PROVIDER: "fake" })?.name).toBe("fake");
    expect(
      providerFromConfig({
        LUME_AI_PROVIDER: "anthropic",
        LUME_AI_MODEL: "claude-test",
        LUME_AI_KEY: "k".repeat(30),
      }),
    ).toMatchObject({ name: "anthropic", model: "claude-test" });
    expect(
      providerFromConfig({
        LUME_AI_PROVIDER: "google",
        LUME_AI_MODEL: "gemini-test",
        LUME_AI_KEY: "k".repeat(30),
      }),
    ).toMatchObject({ name: "google", model: "gemini-test" });
  });
});

describe("aiFromConfig (2026-11-12): the provider, a model per action, and the prices", () => {
  const key = "k".repeat(30);
  const anthropic = {
    LUME_AI_PROVIDER: "anthropic" as const,
    LUME_AI_MODEL: "claude-sonnet-5-5",
    LUME_AI_KEY: key,
  };
  it("no provider: no AI, no models, no prices", () => {
    expect(aiFromConfig({})).toEqual({ ai: null, aiModels: {}, aiPricing: null });
  });
  it("the actions named run on their model; the rest on LUME_AI_MODEL", () => {
    const c = aiFromConfig({
      ...anthropic,
      LUME_AI_TASK_MODELS: "reply_meaning=claude-haiku-5-5,autopilot_first=claude-haiku-5-5",
    });
    expect(c.ai?.model).toBe("claude-sonnet-5-5");
    expect(c.aiModels).toEqual({ reply_meaning: "claude-haiku-5-5", autopilot_first: "claude-haiku-5-5" });
  });
  it("prices every model it can use, with the cache", () => {
    const c = aiFromConfig({
      ...anthropic,
      LUME_AI_TASK_MODELS: "reply_meaning=claude-haiku-5-5",
      LUME_AI_PRICES: "claude-sonnet-5-5=2/10/2.5/0.1,claude-haiku-5-5=0.1/0.5/0.125/0.01",
      LUME_AI_MONTHLY_CAP: 15,
    });
    expect(c.aiPricing).toEqual({
      models: {
        "claude-sonnet-5-5": { in: 2, out: 10, cacheWrite: 2.5, cacheRead: 0.1 },
        "claude-haiku-5-5": { in: 0.1, out: 0.5, cacheWrite: 0.125, cacheRead: 0.01 },
      },
      cap: 15,
    });
  });
  it("the legacy pair still prices the default model", () => {
    const c = aiFromConfig({ ...anthropic, LUME_AI_PRICE_IN: 2, LUME_AI_PRICE_OUT: 10 });
    expect(c.aiPricing?.models["claude-sonnet-5-5"]).toEqual({
      in: 2,
      out: 10,
      cacheWrite: 2.5,
      cacheRead: 0.2,
    });
  });
  it("a bad list or a model without a price stops the server, saying which", () => {
    expect(() => aiFromConfig({ ...anthropic, LUME_AI_TASK_MODELS: "lead_score=claude-haiku-5-5" })).toThrow(
      /lead_score/,
    );
    expect(() =>
      aiFromConfig({
        ...anthropic,
        LUME_AI_TASK_MODELS: "reply_meaning=claude-haiku-5-5",
        LUME_AI_PRICE_IN: 2,
        LUME_AI_PRICE_OUT: 10,
      }),
    ).toThrow(/claude-haiku-5-5/);
  });
  it("models per action mean nothing without a provider", () => {
    expect(aiFromConfig({ LUME_AI_TASK_MODELS: "reply_meaning=claude-haiku-5-5" }).aiModels).toEqual({});
  });
});
