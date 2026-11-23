# Flow Builder (Instagram 1C) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the 1B list editor with an open-canvas flow builder that ManyChat users find familiar (steps anywhere, a line from any button, Ask, Check, Split, Wait, Update the lead), in LUME's own look, with LUME AI building a flow live, a test run on the iPhone, replay, versions, numbers on every step and a problems check.

**Architecture:** Flows become a graph (`v: 2`: nodes with their own exits, positions, notes) stored in the same `draft_steps` / `instagram_flow_versions.steps` jsonb; a pure converter reads every 1B list flow as a graph with the same step ids, so live runs carry on. The interpreter walks edges with hard loop guards. The builder is React Flow (`@xyflow/react`, MIT) with LUME's camera feel (critically damped springs, momentum, zoom about the cursor), custom nodes in LUME's own design, an inspector, and the iPhone test. LUME AI returns validated graph operations that the client plays back with its cursor.

**Tech Stack:** TypeScript, zod, Fastify, Postgres, pg-boss, Next.js, `@xyflow/react`, `dagre` (MIT) for Tidy up, motion, vitest, Playwright; LUME AI on the existing provider (Claude Sonnet 5.5 per LUME AI settings).

**Spec:** Approved canvas https://claude.ai/artifact/KJJDFJ7wddubXwRuked4m9 (boards Builder and BuilderTest; owner 2026-11-23: "i really love the new flow builder ... love this layout"; all remaining Instagram screens approved); research and legal notes `.superpowers/sdd/2026-11-23-flow-builder/research.md`; engine 1B `docs/superpowers/plans/2026-11-22-instagram-1b-flows.md`.

## Global Constraints

- Legal: ManyChat sued a builder for one-for-one copying (2020). Same way of working, never their look: no ManyChat names (Smart Delay, Randomizer, Growth Tools, Quick Automations, Basic Builder, AI Step, Flow Builder Assistant, Copilot), colours, icons, card layout, copy or templates. LUME names: Message, Ask, Check, Split test, Wait, Update the lead, Tell my team, Go to another flow, Hand over, Book a call, Ends, Starts when.
- Meta's rules as 1B enforces them: one private reply per comment, the 24-hour window (7 days after an ad), 3 buttons, 13 quick replies with 20-character titles, 1,000 characters with buttons 640, a person always one word away (person words), automated note where the law asks.
- A run can never loop forever: each node at most 3 visits a run (then it waits for a person, with words), at most 20 messages a run, at most 100 steps a turn.
- Graph sizes: at most 100 nodes, 12 split paths, 50 KB of JSON a flow.
- Replies to leads stay a Max feature (owner 2026-11-23, Q1); Base and Pro build and run flows (1B tiers).
- UI: LUME's tokens (Porcelain, Obsidian, one accent blue), the canvas's camera feel (drag 1:1 with momentum 0.998/ms; pinch and Ctrl/⌘-scroll zoom about the cursor, soft past 0.3–2.4; wheel, buttons, Fit and keys spring with damping 1, response 0.38 s), Reduce Motion snaps. Nothing overflows at 1280–1920 widths in either theme; under 900 px the builder opens as a read-only list with Test and on/off (owner: no overflow).
- Copy speaks as LUME, no em dashes, no guessed pronouns.

## Review Focus

1. A live 1B flow (list) with runs waiting mid-flow when the graph version ships: the runs carry on at the same step ids, and the builder opens the flow as a graph laid out top to bottom.
2. A flow edited while people are in it: their run stays on the version they started (version_id), publishing makes a new version, and Replay shows them on the version they're in.
3. Two people editing one flow: the second save is told to reload (rev), never a silent overwrite, also when the edit came from LUME AI.
4. LUME AI asked for something Meta forbids (a fourth button, a message after the window, a loop with no way out): it says what it changed instead, and never writes an invalid graph.
5. A huge flow on a small laptop: 100 steps pan and zoom at 60 fps (memoised nodes, `onlyRenderVisibleElements`), no layout jump when the inspector opens.

---

## Part A: the graph engine (core + API)

**Built 2026-11-23, with these decisions (recorded as made):**
- A published version never changes, so a 1B list keeps running on 1B's own interpreter (`stepFlow` dispatches); `toGraph` is for the editor only. Safer than routing live lists through the graph interpreter.
- Keyword mode `contains` left out: `word`, `exact` and `any` cover it, and a fourth mode is one more thing to explain.
- Quick replies that branch, with no "anything else" line: other words hand the person to the team, note "Didn't pick a reply" (owner 2026-11-23).
- "Go to another flow" starts the target's live version once this run ends; at most 3 hops a turn (`GOTO_HOPS`), a flow can't go on to itself, a target that isn't live is noted on the lead.
- Follow-ups (`task`) and "Tell my team" to the admins are made after the delivery commits (as the run-as person), like the flow's other notices.
- An Ask's "no answer after" is scheduled (`next_at` = the sooner of it and Meta's window) and run by the due-flows job.

### Task A1: The graph model, its validation, and the 1B converter

**Files:** Create `packages/core/src/instagram/graph.ts`, `graph.test.ts`. Modify `packages/core/src/instagram/index.ts`.

**Interfaces (produces):**
- `type GNode` (discriminated by `type`): `message { id, text, media?: {kind:"image"|"video"|"audio"|"file", fileId}, buttons: {id,title,url}[], replies: {id,title,next:string|null}[], next: string|null }`; `ask { id, text, save:{field,kind:"text"|"email"|"phone"|"number"|"choice"}, choices?: {id,title,next:string|null}[], retry: string, next, noAnswer:{afterMinutes:number,next:string|null} }`; `check { id, match:"all"|"any", rules: FlowCondition[] (FlowCondition gains on:"stage"|"owner"|"source"|"time" and ops "is_not"|"gt"|"lt"), yes, no }`; `split { id, paths:{id,weight,next}[] }`; `wait { id, for:{minutes:number}|{until:{time:"HH:MM", days:number[]}}, next }`; `update { id, actions: ({tag,add}|{field,value:string|null}|{stage}|{assign}|{task:{title,dueMinutes}})[], next }`; `notify { id, to:"owner"|"admins"|{userId}, text, next }`; `goto { id, flowId }`; `handoff` and `book` as 1B (+ `next` on book); `end { id }`.
- `type FlowGraph = { v: 2; start: string|null; nodes: GNode[]; pos: Record<string,{x:number,y:number}>; notes: {id,x,y,text}[] }`.
- `toGraph(steps: FlowStep[] | FlowGraph): FlowGraph` (1B list → graph, same ids, positions top to bottom 160 px apart; branches side by side).
- `validateGraph(g, opts:{ai:boolean; flows:Set<string>}): Problem[]` with `Problem = { nodeId: string|null; words: string; fix?: string }`.
- `GRAPH_LIMITS = { nodes: 100, splitPaths: 12, visits: 3, sends: 20, turnSteps: 100, bytes: 50_000 }`.

- [ ] Tests: `toGraph` keeps ids and exits of every 1B template (magnet, the ad flow, the booking flow) and a nested condition; a graph passes through unchanged; `validateGraph` names: an exit to a node that doesn't exist, a node nothing reaches (warning), a message over Meta's limits, a split whose weights don't total 100, a wait over 7 days, a goto to an archived flow, "No answer leads nowhere" for an ask whose noAnswer is null, an LUME AI handoff without AI, more than 100 nodes.
- [ ] Implement; mutate the unreachable check, the limits and the converter's branch order: killed.

### Task A2: The graph interpreter

**Files:** Modify `packages/core/src/instagram/flows.ts` (stepRun takes `FlowGraph`, routes `v:1` input through `toGraph`), tests in `flows.test.ts` (existing 1B tests keep passing on converted graphs) + `graph-run.test.ts`.

**Interfaces:** `stepRun(flow: FlowStep[] | FlowGraph, state, event, ctx)` unchanged in shape; `RunState` gains `visits: Record<string, number>` (missing = 0) and `waiting` gains `{ for: "reply", nodeId }` (a message's quick replies) and the ask's no-answer deadline `{ for: "answer", stepId, until }`.

- [ ] Tests: a quick reply tap goes down that reply's line (payload `qr:<node>:<reply>`; typed words equal to a title too); an ask with no answer by its deadline takes `noAnswer` (timer event); a split picks by weight with a seeded random from the run id (the same run always the same path); a check with all/any over tag, field, stage, owner, source and time of day (business timezone); a loop back to a check stops at the 4th visit with a handoff "Went round 3 times; waiting for a person"; Wait until 09:00 on weekdays computes in the business timezone and refuses past the window; update/notify/goto emit their actions; private-reply-only and the person word still win; a 1B run state (no `visits`) continues.
- [ ] Implement; mutate the visit guard, the weight pick and the noAnswer deadline: killed.

### Task A3: Saving, publishing, versions and per-step numbers (API)

**Files:** Modify `apps/api/src/modules/instagram/flow-admin.ts`, `flow-routes.ts`, `flow-stats.ts`, `flow-run.ts` (new actions: field, task, notify, goto), `test/probes.ts`; tests `flows-api.test.ts`, `flows-run.test.ts`.

**Interfaces (routes, `instagram.flows.manage`):** `PUT /flows/:id` takes `{ rev, graph: FlowGraph }` (zod bounded; 409 `FLOW_CHANGED` with the newer rev); `GET /flows/:id` returns `{ graph, rev, problems, liveVersion }`; `GET /flows/:id/versions` → `{ versions: {id, version, createdAt, createdBy:{id,name}, live:boolean, changes:{added,removed,changed}}[] }`; `POST /flows/:id/versions/:versionId/restore` → the draft becomes that version's graph (rev+1, audited); `GET /flows/:id/stats?days=30` adds `byNode: Record<nodeId,{sent,read,tapped,answered,entered,yes,no}>` and `byEdge: Record<"from>to", number>`; `GET /flows/:id/runs?lead=<id>` → that lead's runs with the path taken (`trail: {nodeId, at, what}[]`, `waiting: {nodeId, why, until}|null`) for Replay; `POST /flows/test-keyword { text, keywords, mode }` → `{ starts: boolean, keyword }` plus `overlaps: {flowId,name,keyword}[]` (other live flows the same words would also start).

- [ ] Tests for each route, including Review Focus 1–3; trigger mode gains `"contains"` (default stays `"word"`).
- [ ] Implement (trail recorded as flow events `kind: "entered"` per node; migration `0127_flow_graph.sql` adds the kind and an index on `(run_id, at)`); mutate rev check, restore audit, overlap finder: killed.

## Part B: the builder (web)

### Task B1: The canvas, nodes and camera

**Files:** Create `apps/web/src/components/flows/builder/{Builder.tsx, Canvas.tsx, nodes/*.tsx, edges/Wire.tsx, camera.ts, Rail.tsx, ZoomBar.tsx, Minimap.tsx, builder.module.css}`; route `apps/web/src/app/(app)/flows/[id]/page.tsx` (full window, ← Flows); add `@xyflow/react` and `dagre` to `apps/web/package.json` (`dev.sh add`).

- [ ] Tests (RTL + unit): nodes render the canvas's cards (Starts when with triggers and keyword chips, Message with bubble and reply exits, Ask with Answered / No answer, Check Yes/No, Split paths with %, Wait, Update, Tell my team, Go to, Hand over, Book, Ends); a line drawn from an exit to a node sets that exit's `next`; Delete removes a node and clears exits pointing at it; Undo/Redo (Ctrl Z / Ctrl Shift Z) over 100 steps; copy/paste keeps exits inside the copied set and drops the rest; `camera.ts` pure functions (`zoomAbout`, `project`, `springStep`) against the canvas board's numbers.
- [ ] Implement with React Flow's viewport driven by `camera.ts` (the canvas board's engine, typed), `nodeTypes` stable, nodes `memo`, `onlyRenderVisibleElements` past 40 nodes; Tidy up with dagre left to right; double-click empty canvas or `/` opens the step picker at the pointer.

### Task B2: The inspector, problems, Numbers and Publish

**Files:** `Inspector.tsx` + one editor per node type, `ProblemsPopover.tsx`, `NumbersOverlay.tsx`, `TopBar.tsx`.

- [ ] Tests: each editor writes its node (message text with `{` field tokens, buttons max 3, replies max 13 with 20-character counter, Instagram's limits box live); the keyword tester in Starts when calls `test-keyword` and shows overlaps; Problems lists `validateGraph` problems with Show me (selects and centres the node); Publish blocked while problems exist; Numbers shows `byNode` on cards and `byEdge` on wires; autosave (debounced 800 ms, rev) with "Saved" and conflict handling.

### Task B3: Test on the iPhone, Replay, Versions

**Files:** `TestPanel.tsx` (the approved iPhone from the canvas, Instagram's chat look), `simulate.ts` (runs `stepRun` in the browser on the draft graph with the person's taps and typed answers; checks ask the tester), `ReplayPanel.tsx`, `VersionsPanel.tsx`.

- [ ] Tests: the simulator lights each visited node and wire, the quick replies appear above the composer, a typed email is checked as the engine checks it, Check asks "Does Priya follow you?" in a test, Play again resets; "On my Instagram" sends to the admin's own test account through a new `POST /flows/:id/test-send { igsid }` (Max only, refuses a lead's igsid); Replay draws a lead's trail; Versions shows changes and restores.

## Part C: LUME AI builds it

### Task C1: The build endpoint

**Files:** `apps/api/src/modules/instagram/flow-ai.ts`, route `POST /flows/:id/ai-build { prompt, selection?: string[] }` → `{ plan: string[], ops: GraphOp[], said: string }` where `GraphOp = {op:"add",node,pos} | {op:"connect",from:{node,exit},to} | {op:"edit",node} | {op:"remove",nodeId}`; Max or the AI module on (as LUME AI elsewhere); costed as LUME AI actions; prompt and tool schema in `packages/core/src/ai/flow-build.ts`.

- [ ] Tests (fake provider): ops applied to the draft give a graph that passes `validateGraph`; a provider answer with a 4th button or a dangling exit is repaired or refused with `said` saying what changed (Review Focus 4); never touches the live version; audit `instagram.flow_ai`.

### Task C2: The cursor playback

**Files:** `AiBar.tsx`, `AiCursor.tsx`, `PlanCard.tsx` (the canvas board's look and timings), playback queue in `Builder.tsx`.

- [ ] Tests: the camera fits the flow first; each op lands as the cursor arrives (≥ 900 ms apart, Reduce Motion: all at once); nodes tinted New until Keep; Discard restores the draft from before (one undo step); Stop keeps what landed.

## Part D: the other approved Instagram screens

### Task D1–D6 (one each, canvas boards Main, Connect, Thread/ThreadDark/Phone, Replies, NotYet, Analytics)

Each: the board's copy and states as approved, wired to the 1A/1B API that already serves them, its RTL tests, its Playwright pass with axe and the no-overflow check at 375/768/1280/1440 in both themes.

## Finish

- [ ] Full gate (`dev.sh test-db clean` and no stale toolbox first), fresh reviewer on the whole branch, fixes, push per part (A, B, C, D) so each lands green on its own.
