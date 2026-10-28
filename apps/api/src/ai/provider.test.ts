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
import { providerFromConfig } from "./from-config";
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
    expect(r).toEqual({ output: answer, inputTokens: 412, outputTokens: 57 });
    expect(seen[0]!.path).toBe("/v1/messages");
    expect(seen[0]!.headers["x-api-key"]).toBe("sk-test-key-000000000000");
    const b = seen[0]!.body;
    expect(b).toMatchObject({ model: "claude-test", max_tokens: 800, system: "Rules." });
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
    expect(r).toEqual({ output: answer, inputTokens: 398, outputTokens: 61 });
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

  it("an answer that doesn't match the schema is AiUnreadable", async () => {
    reply = () => ({ status: 200, body: gemini('{"summary":true}') });
    const p = googleProvider({ apiKey: "g-test-key-0000000000000", model: "gemini-test", baseURL: base });
    await expect(p.read(ask())).rejects.toBeInstanceOf(AiUnreadable);
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
