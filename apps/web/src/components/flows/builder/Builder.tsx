"use client";
import "@xyflow/react/dist/base.css";
import {
  Background,
  BackgroundVariant,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  type Connection,
  type Edge,
  type OnEdgesChange,
  type OnNodesChange,
} from "@xyflow/react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useReducedMotion } from "motion/react";
import { applyOps, type FlowGraph, type GNode, type GraphOp } from "@lume/core/shared";
import { api } from "@/lib/api";
import {
  flowsClient,
  type FlowAiBuild,
  type FlowStats,
  type FlowVersion,
  type FlowView,
} from "@/lib/flows/client";
import {
  addNode,
  connect,
  disconnect,
  duplicate,
  History,
  linesOf,
  moveNode,
  removeNodes,
  replaceNode,
} from "./graph-edit";
import { KindIcon, StepCard, type StepNode } from "./StepCard";
import { StartCard, type StartNode } from "./StartCard";
import { KINDS, RAIL, type StepKind } from "./kinds";
import { useCamera } from "./useCamera";
import { Inspector, type FlowChoice } from "./Inspector";
import { StartPanel, type TriggerDraft } from "./StartPanel";
import { TestPanel } from "./TestPanel";
import { ReplayPanel } from "./ReplayPanel";
import { VersionsPanel } from "./VersionsPanel";
import type { Tool } from "./PanelHead";
import { AiBar, type AiPhase } from "./AiBar";
import { AiCursor } from "./AiCursor";
import { PlanCard } from "./PlanCard";
import type { FlowTrigger } from "@/lib/flows/client";
import type { Catalog } from "@/lib/leads/types";
import s from "./builder.module.css";

/** Where Starts when sits, kept with the steps' places. */
export const START = "_start";
const NODE_W = 244;
const SAVE_MS = 800;
const nodeTypes = { step: StepCard, start: StartCard };
const newId = () => Math.random().toString(36).slice(2, 10);
const ZERO = { entered: 0, people: 0, sent: 0 };
/** LUME AI's beat (C2): the cursor's move to the next step, which lands as it arrives (at least 900 ms apart). */
export const BEAT_MS = 950;
/** What LUME AI's cursor says it's doing, by the step it's adding. */
const DOING: Record<GNode["type"], string> = {
  message: "Writing a message",
  ask: "Asking a question",
  check: "Adding a check",
  split: "Adding a split test",
  wait: "Adding a wait",
  update: "Updating the lead",
  notify: "Telling the team",
  goto: "Going to another flow",
  handoff: "Handing over",
  book: "Adding a booking link",
  end: "Ending the flow",
};
/** Ops in beats: one add, edit or removal each, with the lines drawn after it (a line lands with its step). */
function beatsOf(ops: GraphOp[]): GraphOp[][] {
  const beats: GraphOp[][] = [];
  for (const o of ops) {
    if (o.op === "connect" && beats.length) beats.at(-1)!.push(o);
    else beats.push([o]);
  }
  return beats;
}
const plural = (n: number) => `${n} step${n === 1 ? "" : "s"}`;

type Saved = "saved" | "saving" | "unsaved" | "changed-elsewhere" | "failed";

/** The flow builder (plan 2026-11-23-flow-builder, Part B; approved canvas KJJDFJ7wddubXwRuked4m9, board Builder). */
type Props = { initial: FlowView; catalog: Catalog; flows: FlowChoice[]; businessName: string };

export function Builder(p: Props) {
  return (
    <ReactFlowProvider>
      <BuilderInner {...p} />
    </ReactFlowProvider>
  );
}

function BuilderInner({ initial, catalog, flows, businessName }: Props) {
  const reduce = !!useReducedMotion();
  const [graph, setGraph] = useState<FlowGraph>(initial.graph);
  const [issues, setIssues] = useState(initial.issues);
  const [problems, setProblems] = useState(initial.problems);
  const [view, setView] = useState(initial);
  const [saved, setSaved] = useState<Saved>("saved");
  const [selected, setSelected] = useState<string[]>([]);
  const [showProblems, setShowProblems] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  // The flow's side panel (Test, Replay, Versions), and the view: the steps to build, or their numbers.
  const [tool, setTool] = useState<Tool | null>(null);
  const [mode, setMode] = useState<"build" | "numbers">("build");
  const [stats, setStats] = useState<FlowStats | null>(null);
  const [statsSaid, setStatsSaid] = useState<string | null>(null);
  const router = useRouter();
  const [lit, setLit] = useState<string[]>([]);
  const onLit = useCallback((ids: string[]) => setLit(ids), []);
  // Ways in changed and not saved yet: kept here, so closing the panel never loses them.
  const [triggerDraft, setTriggerDraft] = useState<TriggerDraft | null>(null);
  const draftRef = useRef<TriggerDraft | null>(null);
  const onDraft = useCallback((d: TriggerDraft | null) => {
    draftRef.current = d;
    setTriggerDraft(d);
  }, []);
  const history = useRef(new History(100));
  const clip = useRef<string[]>([]);
  const camera = useCamera({ reduce });

  // LUME AI builds the flow (C2): where it is, its words, its plan, the steps it made (New until kept), its cursor.
  const [aiPhase, setAiPhase] = useState<AiPhase>("idle");
  const [prompt, setPrompt] = useState("");
  const [aiPlan, setAiPlan] = useState<{ rows: string[]; said: string } | null>(null);
  const [beat, setBeat] = useState({ at: 0, of: 0 });
  const [fresh, setFresh] = useState<ReadonlySet<string>>(() => new Set());
  const [cursor, setCursor] = useState<{ x: number; y: number; label: string } | null>(null);
  const [doneSay, setDoneSay] = useState("");
  const aiBusy = aiPhase === "asking" || aiPhase === "playing";
  /** The canvas is LUME AI's from Build it until Keep, Discard or a failure (C2 detail): nothing else changes it. */
  const aiLocked = aiPhase !== "idle";
  /** Which ask is current: Stop, a new ask or leaving moves it on, and anything from an older one is dropped. */
  const aiRun = useRef(0);
  const aiTimers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const aiBefore = useRef<FlowGraph | null>(null);
  const aiLanded = useRef({ beats: 0, added: 0, changed: 0 });

  // The truth, outside React's updaters (which must stay pure: review 2026-11-24): the graph on screen, the last graph
  // the server has, the version it's at, and the save pipeline (one at a time).
  const graphRef = useRef(initial.graph);
  const savedGraph = useRef(initial.graph);
  const rev = useRef(initial.rev);
  const inFlight = useRef(false);
  const again = useRef(false);
  const conflict = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const failures = useRef(0);
  /** Gone from the screen: nothing more is saved from here (the way-out send covers the last edit). */
  const gone = useRef(false);
  const scheduleRef = useRef<() => void>(() => undefined);

  /**
   * Saves the graph on screen. Every write (this, the ways in, Publish) goes one at a time, each with the version the
   * one before it left (inFlight is the line: review 2026-11-24); an edit made meanwhile is saved right after.
   */
  const flush = useCallback(async () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    if (conflict.current || gone.current) return;
    if (inFlight.current) {
      again.current = true;
      return;
    }
    const sending = graphRef.current;
    if (sending === savedGraph.current) {
      setSaved("saved");
      return;
    }
    inFlight.current = true;
    setSaved("saving");
    const r = await flowsClient.save(initial.id, { rev: rev.current, graph: sending });
    inFlight.current = false;
    if (r.ok) {
      failures.current = 0;
      rev.current = r.data.rev;
      savedGraph.current = sending;
      setIssues(r.data.issues);
      setProblems(r.data.problems);
      setView(r.data);
      if (gone.current) {
        // Left while it saved: anything newer goes on the way out, once.
        if (graphRef.current !== sending)
          api.keepalive("PUT", `/api/v1/instagram/flows/${encodeURIComponent(initial.id)}`, {
            rev: rev.current,
            graph: graphRef.current,
          });
      } else if (again.current || graphRef.current !== sending) {
        again.current = false;
        scheduleRef.current();
      } else setSaved("saved");
    } else if (r.status === 409) {
      // Someone else saved first: it stays that way until a reload, so nothing is ever saved over their change.
      conflict.current = true;
      setSaved("changed-elsewhere");
    } else if (!gone.current) {
      // Tried again on its own, a little later each time (up to half a minute).
      setSaved("failed");
      failures.current += 1;
      timer.current = setTimeout(() => void flush(), Math.min(30_000, 2_000 * 2 ** (failures.current - 1)));
    }
  }, [initial.id]);

  const schedule = useCallback(() => {
    if (conflict.current) return;
    setSaved((v) => (v === "saving" ? v : "unsaved"));
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void flush(), SAVE_MS);
  }, [flush]);
  scheduleRef.current = schedule;

  /** Every change: the new graph on screen, a step for Undo (or none, mid-drag or mid-typing), a save shortly after. */
  const commit = useCallback(
    (next: FlowGraph, record = true) => {
      const before = graphRef.current;
      if (next === before) return;
      if (record) history.current.push(before);
      else history.current.forgetFuture();
      graphRef.current = next;
      setGraph(next);
      schedule();
    },
    [schedule],
  );
  const change = useCallback(
    (f: (g: FlowGraph) => FlowGraph, record = true) => commit(f(graphRef.current), record),
    [commit],
  );

  // Leaving with an edit not yet saved: it goes on the way out, and the browser asks first while it can.
  useEffect(() => {
    const unsaved = () => !conflict.current && graphRef.current !== savedGraph.current;
    const sendNow = () => {
      if (!unsaved() || inFlight.current) return;
      api.keepalive("PUT", `/api/v1/instagram/flows/${encodeURIComponent(initial.id)}`, {
        rev: rev.current,
        graph: graphRef.current,
      });
    };
    const ask = (e: BeforeUnloadEvent) => {
      if (unsaved() || inFlight.current || draftRef.current) e.preventDefault();
    };
    // Back from the browser's back/forward cache after the way-out send moved the version on: start afresh.
    const back = (e: PageTransitionEvent) => {
      if (e.persisted) window.location.reload();
    };
    // The token in hand from the start, so the way-out send never goes without one.
    void api.prime();
    gone.current = false;
    window.addEventListener("pagehide", sendNow);
    window.addEventListener("pageshow", back);
    window.addEventListener("beforeunload", ask);
    return () => {
      window.removeEventListener("pagehide", sendNow);
      window.removeEventListener("pageshow", back);
      window.removeEventListener("beforeunload", ask);
      if (timer.current) clearTimeout(timer.current);
      gone.current = true;
      sendNow();
    };
  }, [initial.id]);

  // Numbers: the last 30 days, the business's days, read when the view opens (and again each time it opens).
  useEffect(() => {
    if (mode !== "numbers") return;
    let live = true;
    setStats(null);
    setStatsSaid(null);
    void flowsClient.stats(initial.id, 30).then((r) => {
      if (!live) return;
      if (r.ok) setStats(r.data);
      else {
        setStatsSaid(r.message);
        setNotice(`The numbers didn't load. ${r.message}`);
      }
    });
    return () => {
      live = false;
    };
  }, [mode, initial.id]);
  const numbers = mode === "numbers" ? stats : null;

  const problemsBy = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of issues) if (p.nodeId && !p.warning) m.set(p.nodeId, (m.get(p.nodeId) ?? 0) + 1);
    return m;
  }, [issues]);

  // Each card's data kept while its step and its problems are the same, so a drag re-renders only what moved.
  const dataCache = useRef(
    new Map<
      string,
      {
        node: GNode;
        problems: number;
        lit: boolean;
        stat: FlowStats["byStep"][string] | null;
        fresh: boolean;
        data: StepNode["data"];
      }
    >(),
  );
  const nodes = useMemo(() => {
    const start: StartNode = {
      id: START,
      type: "start",
      position: graph.pos[START] ?? { x: -300, y: 0 },
      data: { triggers: view.triggers },
      deletable: false,
      selected: selected.includes(START),
      style: { width: 220 },
    };
    const cache = dataCache.current;
    const live = new Set<string>();
    const steps: StepNode[] = graph.nodes.map((n) => {
      live.add(n.id);
      const problems = problemsBy.get(n.id) ?? 0;
      const on = lit.includes(n.id);
      // Numbers: what this step did over the range (a step nobody reached shows its zeros).
      const stat = numbers ? (numbers.byStep[n.id] ?? ZERO) : null;
      const isNew = fresh.has(n.id);
      let hit = cache.get(n.id);
      if (
        !hit ||
        hit.node !== n ||
        hit.problems !== problems ||
        hit.lit !== on ||
        hit.stat !== stat ||
        hit.fresh !== isNew
      ) {
        hit = {
          node: n,
          problems,
          lit: on,
          stat,
          fresh: isNew,
          data: { node: n, problems, lit: on, stats: stat, fresh: isNew },
        };
        cache.set(n.id, hit);
      }
      return {
        id: n.id,
        type: "step",
        position: graph.pos[n.id] ?? { x: 0, y: 0 },
        data: hit.data,
        selected: selected.includes(n.id),
        style: { width: NODE_W },
      };
    });
    for (const id of cache.keys()) if (!live.has(id)) cache.delete(id);
    return [start, ...steps];
  }, [graph, view.triggers, selected, problemsBy, lit, numbers, fresh]);

  const edges = useMemo<Edge[]>(
    () =>
      linesOf(graph).map((l) => ({
        id: l.id,
        source: l.from === "start" ? START : l.from,
        sourceHandle: l.exit,
        target: l.to,
        targetHandle: "in",
        selected: selected.includes(l.id),
        // Numbers: how many runs went down this line (from one step to the next).
        ...(numbers && l.from !== "start"
          ? { label: (numbers.byLine[`${l.from}>${l.to}`] ?? 0).toLocaleString("en-IN") }
          : {}),
      })),
    [graph, selected, numbers],
  );

  const onNodesChange = useCallback<OnNodesChange<StepNode | StartNode>>(
    (changes) => {
      for (const c of changes.toArray()) {
        if (c.type === "position" && c.position) change((g) => moveNode(g, c.id, c.position!), false);
        if (c.type === "select")
          setSelected((sel) => (c.selected ? [...new Set([...sel, c.id])] : sel.filter((x) => x !== c.id)));
      }
    },
    [change],
  );
  const onEdgesChange = useCallback<OnEdgesChange<Edge>>((changes) => {
    for (const c of changes.toArray())
      if (c.type === "select")
        setSelected((sel) => (c.selected ? [...new Set([...sel, c.id])] : sel.filter((x) => x !== c.id)));
  }, []);
  const onConnect = useCallback(
    (c: Connection) => {
      if (!c.target || !c.sourceHandle) return;
      change((g) =>
        connect(g, { node: c.source === START ? "start" : c.source, exit: c.sourceHandle! }, c.target),
      );
    },
    [change],
  );
  const remove = useCallback(
    (ids: string[]) => {
      const lines = ids.filter((x) => x.includes(">"));
      const steps = ids.filter((x) => !x.includes(">") && x !== START);
      change((g) => {
        let n = g;
        for (const l of lines) {
          const [from, exit] = l.split(">") as [string, string];
          n = disconnect(n, { node: from === START || from === "start" ? "start" : from, exit });
        }
        return steps.length ? removeNodes(n, steps) : n;
      });
      setSelected([]);
    },
    [change],
  );

  /** A new step in the middle of what's on screen. */
  const add = useCallback(
    (kind: StepKind) => {
      const id = newId();
      const host = camera.hostRef.current?.getBoundingClientRect();
      const c = camera.cam;
      const at = host
        ? { x: (host.width / 2 - c.x) / c.z - NODE_W / 2, y: (host.height / 2 - c.y) / c.z - 60 }
        : { x: 0, y: 0 };
      change((g) => addNode(g, KINDS[kind].make(id), at));
      setSelected([id]);
    },
    [camera, change],
  );

  // An edit in the panel: one step for Undo per pause in typing, not one per letter.
  const lastEdit = useRef({ at: 0, id: "" });
  const editNode = useCallback(
    (n: GNode) => {
      const now = Date.now();
      const record = now - lastEdit.current.at > 1000 || lastEdit.current.id !== n.id;
      lastEdit.current = { at: now, id: n.id };
      change((g) => replaceNode(g, n), record);
    },
    [change],
  );

  /** Undo and Redo: only when there's a step to take (nothing changes, nothing to save). */
  const step = useCallback(
    (back: boolean) => {
      const now = graphRef.current;
      const g = back ? history.current.undo(now) : history.current.redo(now);
      if (!g) return;
      // Typing after Undo or Redo is its own step to undo.
      lastEdit.current = { at: 0, id: "" };
      graphRef.current = g;
      setGraph(g);
      schedule();
    },
    [schedule],
  );

  const fitGraph = useCallback(
    (g: FlowGraph, room?: { left: number }) => {
      const xs = Object.entries(g.pos);
      if (!xs.length) return;
      const minX = Math.min(...xs.map(([, p]) => p.x));
      const minY = Math.min(...xs.map(([, p]) => p.y));
      const maxX = Math.max(...xs.map(([, p]) => p.x)) + NODE_W;
      const maxY = Math.max(...xs.map(([, p]) => p.y)) + 220;
      camera.fit({ x: minX, y: minY, w: maxX - minX, h: maxY - minY }, false, room);
    },
    [camera],
  );
  const fitAll = useCallback(() => {
    const xs = Object.entries(graphRef.current.pos);
    if (!xs.length) return;
    const minX = Math.min(...xs.map(([, p]) => p.x));
    const minY = Math.min(...xs.map(([, p]) => p.y));
    const maxX = Math.max(...xs.map(([, p]) => p.x)) + NODE_W;
    const maxY = Math.max(...xs.map(([, p]) => p.y)) + 220;
    camera.fit({ x: minX, y: minY, w: maxX - minX, h: maxY - minY }, false);
  }, [camera]);

  // The whole flow in view when it opens.
  useEffect(() => {
    const t = setTimeout(fitAll, 30);
    return () => clearTimeout(t);
  }, []);

  /** Copies of these steps (Duplicate, Paste), selected once they're on the canvas. */
  const copy = (ids: string[]) => {
    const g = graphRef.current;
    const r = duplicate(
      g,
      ids.filter((id) => g.nodes.some((n) => n.id === id)),
      newId,
    );
    commit(r.graph);
    setSelected(r.ids);
  };

  // Keys, on the builder only: Undo, Redo, Duplicate, Copy, Paste, Fit, zoom. Never while typing.
  const onKey = (e: React.KeyboardEvent) => {
    if ((e.target as HTMLElement).closest("input, textarea, select, [contenteditable]")) return;
    // The canvas is LUME AI's while it builds.
    if (aiLocked) return;
    const mod = e.metaKey || e.ctrlKey;
    const k = e.key.toLowerCase();
    const steps = selected.filter((x) => x !== START && !x.includes(">"));
    if (mod && k === "z") {
      e.preventDefault();
      step(!e.shiftKey);
    } else if (mod && k === "y") {
      e.preventDefault();
      step(false);
    } else if (mod && k === "d" && steps.length) {
      e.preventDefault();
      copy(steps);
    } else if (mod && k === "c" && steps.length) clip.current = steps;
    else if (mod && k === "v" && clip.current.length) {
      e.preventDefault();
      copy(clip.current);
    } else if (!mod && (k === "delete" || k === "backspace") && selected.length) {
      e.preventDefault();
      remove(selected);
    } else if (!mod && k === "escape" && showProblems) setShowProblems(false);
    else if (!mod && k === "1") fitAll();
    else if (!mod && (k === "+" || k === "=")) camera.zoomIn();
    else if (!mod && k === "-") camera.zoomOut();
    else if (!mod && k === "0") camera.zoomReset();
  };

  /** Its turn on the write line: whatever is on its way finishes first. */
  const turn = async () => {
    while (inFlight.current) await new Promise((r) => setTimeout(r, 100));
  };
  /** After a write that wasn't the steps': steps changed meanwhile are saved now, or on the way out if gone. */
  const afterWrite = () => {
    again.current = false;
    if (conflict.current || graphRef.current === savedGraph.current) return;
    if (gone.current)
      api.keepalive("PUT", `/api/v1/instagram/flows/${encodeURIComponent(initial.id)}`, {
        rev: rev.current,
        graph: graphRef.current,
      });
    else scheduleRef.current();
  };
  const CHANGED_ELSEWHERE = "Someone else changed this flow meanwhile. Reload first.";
  /** A write went through and the steps on screen are the saved ones: whatever a failed save said is over. */
  const settled = () => {
    if (graphRef.current !== savedGraph.current) return;
    failures.current = 0;
    setSaved("saved");
  };

  /**
   * What starts the flow, on the same write line as the steps: a save on its way finishes, steps changed and not saved
   * yet go first (so the version moves once, in order), then it goes with the version they left.
   */
  const saveTriggers = async (t: FlowTrigger[]): Promise<{ ok: boolean; message?: string }> => {
    if (conflict.current) return { ok: false, message: CHANGED_ELSEWHERE };
    await turn();
    if (graphRef.current !== savedGraph.current) {
      await flush();
      await turn();
    }
    // Left while it waited: the way-out send has the steps, and nothing more goes over it (review 2026-11-24).
    if (gone.current) return { ok: false };
    if (conflict.current) return { ok: false, message: CHANGED_ELSEWHERE };
    inFlight.current = true;
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const r = await flowsClient.setTriggers(initial.id, rev.current, t);
    inFlight.current = false;
    if (r.ok) {
      rev.current = r.data.rev;
      setView(r.data);
      setIssues(r.data.issues);
      setProblems(r.data.problems);
      settled();
    } else if (r.code === "FLOW_CHANGED") {
      conflict.current = true;
      setSaved("changed-elsewhere");
    }
    afterWrite();
    return r.ok ? { ok: true } : { ok: false, message: r.message };
  };

  const blocking = problems.length;
  /** Publish what's saved, on the write line: it goes with the version the write before it left. */
  const publish = async () => {
    setPublishing(true);
    await turn();
    if (gone.current) return;
    if (conflict.current) {
      setPublishing(false);
      return;
    }
    inFlight.current = true;
    const r = await flowsClient.publish(initial.id, rev.current);
    inFlight.current = false;
    setPublishing(false);
    if (r.ok) {
      rev.current = r.data.rev;
      setView(r.data);
      setNotice(`Version ${r.data.live?.version ?? ""} is live.`);
    } else if (r.status === 409) {
      conflict.current = true;
      setSaved("changed-elsewhere");
    } else setNotice(r.message);
    // An edit made while it published is saved now, with the version Publish left.
    afterWrite();
  };
  /**
   * A version back into the draft, on the write line like every write: what's on screen now goes first, then the
   * restore with the version that left. The draft before it is one Undo away (Undo saves it back).
   */
  const restoreVersion = async (v: FlowVersion): Promise<{ ok: boolean; message?: string }> => {
    if (conflict.current) return { ok: false, message: CHANGED_ELSEWHERE };
    await turn();
    if (graphRef.current !== savedGraph.current) {
      await flush();
      await turn();
    }
    if (gone.current) return { ok: false };
    if (conflict.current) return { ok: false, message: CHANGED_ELSEWHERE };
    inFlight.current = true;
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const r = await flowsClient.restore(initial.id, v.id, rev.current);
    inFlight.current = false;
    if (r.ok) {
      rev.current = r.data.rev;
      history.current.push(graphRef.current);
      graphRef.current = r.data.graph;
      savedGraph.current = r.data.graph;
      setGraph(r.data.graph);
      setView(r.data);
      setIssues(r.data.issues);
      setProblems(r.data.problems);
      settled();
    } else if (r.code === "FLOW_CHANGED") {
      conflict.current = true;
      setSaved("changed-elsewhere");
    }
    afterWrite();
    return r.ok ? { ok: true } : { ok: false, message: r.message };
  };
  /** A version as a new draft flow, opened straight away (nothing here changes). */
  const copyVersion = async (v: FlowVersion): Promise<{ ok: boolean; message?: string }> => {
    // Opening the copy leaves this flow: changes to what starts it, not saved yet, would go with it (review 2026-11-24).
    if (draftRef.current)
      return {
        ok: false,
        message: "Save or undo your changes to Starts when first, then copy this version.",
      };
    const r = await flowsClient.duplicate(initial.id, v.id);
    if (!r.ok) return { ok: false, message: r.message };
    router.push(`/instagram/flows/${encodeURIComponent(r.data.id)}`);
    return { ok: true };
  };
  // ── LUME AI builds the flow (plan 2026-11-23-flow-builder, C2 detail) ─────────────────────────────────────────
  const clearBeats = () => {
    for (const t of aiTimers.current) clearTimeout(t);
    aiTimers.current = [];
  };
  // Leaving mid-build: no beat lands after (what landed goes on the way out like any edit).
  useEffect(
    () => () => {
      aiRun.current++;
      for (const t of aiTimers.current) clearTimeout(t);
    },
    [],
  );

  /** Done, or stopped: Keep or Discard next. */
  const doneWords = () => {
    const l = aiLanded.current;
    return l.added
      ? `LUME AI built ${plural(l.added)}.`
      : l.changed
        ? `LUME AI changed ${plural(l.changed)}.`
        : "LUME AI changed the lines between steps.";
  };

  /** One beat: its ops land on the graph on screen (saved like any edit), and the cursor is on its step. */
  const land = (ops: GraphOp[], first: boolean) => {
    const before = graphRef.current;
    // The draft before the build is one Undo step; the beats add none.
    if (first) history.current.push(before);
    const g = applyOps(before, ops);
    graphRef.current = g;
    setGraph(g);
    schedule();
    const made = ops.flatMap((o) => (o.op === "add" || o.op === "edit" ? [o.node.id] : []));
    if (made.length) setFresh((f) => new Set([...f, ...made]));
    for (const o of ops) {
      if (o.op === "add") aiLanded.current.added++;
      else if (o.op === "edit" || o.op === "remove") aiLanded.current.changed++;
    }
    aiLanded.current.beats++;
  };

  /** Where the cursor goes for a beat, and what it says: the step it lands, in the flow as it will be. */
  const aimOf = (ops: GraphOp[], before: FlowGraph, after: FlowGraph) => {
    const lead = ops[0]!;
    const at =
      lead.op === "add" || lead.op === "edit"
        ? after.pos[lead.node.id]
        : lead.op === "remove"
          ? before.pos[lead.nodeId]
          : lead.to
            ? after.pos[lead.to]
            : undefined;
    const label =
      lead.op === "add"
        ? DOING[lead.node.type]
        : lead.op === "edit"
          ? "Changing this step"
          : lead.op === "remove"
            ? "Taking out a step"
            : "Joining the steps";
    return at ? { x: at.x + 18, y: at.y + 22, label } : null;
  };

  /** Someone else saved meanwhile: nothing more lands on a flow that can't be saved (the banner says why). */
  const abandon = () => {
    aiRun.current++;
    clearBeats();
    setCursor(null);
    setAiPlan(null);
    setFresh(new Set());
    setAiPhase("idle");
  };

  const finish = () => {
    clearBeats();
    setCursor(null);
    setDoneSay(doneWords());
    setAiPhase("done");
  };

  /** LUME AI's answer, played onto the canvas: the whole next flow in view first, then a step a beat. */
  const play = (a: FlowAiBuild) => {
    aiBefore.current = graphRef.current;
    aiLanded.current = { beats: 0, added: 0, changed: 0 };
    const beats = beatsOf(a.ops);
    setAiPlan({ rows: a.plan, said: a.said });
    setBeat({ at: 0, of: beats.length });
    setAiPhase("playing");
    const before = graphRef.current;
    const after = applyOps(before, a.ops);
    // The whole next flow in view, clear of the plan card (68 px in, 300 wide, and a gap).
    fitGraph(after, { left: 384 });
    if (reduce) {
      land(a.ops, true);
      setBeat({ at: beats.length, of: beats.length });
      finish();
      return;
    }
    // The cursor sets off for a step a beat before it lands, so the step lands as it arrives.
    const aim = (i: number) => {
      const c = aimOf(beats[i]!, before, after);
      if (c) setCursor(c);
    };
    aim(0);
    beats.forEach((ops, i) =>
      aiTimers.current.push(
        setTimeout(
          () => {
            if (conflict.current) return abandon();
            land(ops, i === 0);
            if (i + 1 < beats.length) aim(i + 1);
            setBeat({ at: i + 1, of: beats.length });
            if (i === beats.length - 1) finish();
          },
          (i + 1) * BEAT_MS,
        ),
      ),
    );
  };

  /** Build it: the screen's steps saved first (on the write line), then LUME AI asked; the canvas is its meanwhile. */
  const buildWithAi = async () => {
    const words = prompt.trim();
    if (!words || aiBusy) return;
    const run = ++aiRun.current;
    const g0 = graphRef.current;
    const selection = selected.filter(
      (x) => x !== START && !x.includes(">") && g0.nodes.some((n) => n.id === x),
    );
    clearBeats();
    setFresh(new Set());
    setAiPlan(null);
    setSelected([]);
    setTool(null);
    setShowProblems(false);
    setNotice(null);
    setAiPhase("asking");
    await turn();
    if (graphRef.current !== savedGraph.current) {
      await flush();
      await turn();
    }
    if (run !== aiRun.current) return;
    if (conflict.current) {
      setAiPhase("idle");
      return;
    }
    if (graphRef.current !== savedGraph.current) {
      setNotice("LUME couldn't save the flow first, so LUME AI hasn't started. Try again in a moment.");
      setAiPhase("idle");
      return;
    }
    const r = await flowsClient.aiBuild(
      initial.id,
      selection.length ? { prompt: words, selection } : { prompt: words },
    );
    if (run !== aiRun.current) return;
    if (!r.ok) {
      setNotice(r.message);
      setAiPhase("idle");
      return;
    }
    if (r.data.refused || r.data.ops.length === 0) {
      setNotice(r.data.said);
      setAiPhase("idle");
      return;
    }
    play(r.data);
  };

  const stopAi = () => {
    aiRun.current++;
    clearBeats();
    setCursor(null);
    // Nothing landed yet: nothing to keep.
    if (aiPhase === "asking" || aiLanded.current.beats === 0) {
      setAiPlan(null);
      setAiPhase("idle");
      return;
    }
    setDoneSay(doneWords());
    setAiPhase("done");
    setNotice("Stopped. What LUME AI made so far stays, marked New.");
  };
  const keepAi = () => {
    setFresh(new Set());
    setAiPlan(null);
    setPrompt("");
    setAiPhase("idle");
    setNotice("Kept. Undo takes the whole build back in one step.");
  };
  const discardAi = () => {
    // The draft before, as one change: Undo brings the build back.
    if (aiBefore.current) commit(aiBefore.current);
    setFresh(new Set());
    setAiPlan(null);
    setAiPhase("idle");
    setNotice("Discarded. The canvas is as it was.");
  };
  const planAt = aiPlan?.rows.length
    ? Math.min(aiPlan.rows.length - 1, Math.floor((beat.at * aiPlan.rows.length) / Math.max(1, beat.of)))
    : 0;
  const sidePanel =
    tool !== null ||
    (selected.length === 1 && (selected[0] === START || graph.nodes.some((n) => n.id === selected[0])));

  const openTool = (t: Tool | null) => {
    setTool(t);
    if (t) setSelected([]);
  };

  const showStep = (id: string) => {
    const p = graph.pos[id];
    if (!p) return;
    setSelected([id]);
    setShowProblems(false);
    camera.centerOn(p.x + NODE_W / 2, p.y + 80);
  };

  return (
    <div className={s.fb} onKeyDown={onKey} data-full-canvas="">
      <header className={s.top}>
        <Link href="/settings/integrations" className={s.back}>
          <svg
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            aria-hidden
          >
            <path d="M10 3 5 8l5 5" />
          </svg>
          Instagram
        </Link>
        <span className={s.name} title={view.name}>
          {view.name}
        </span>
        <span className={s.saved} role="status" aria-live="polite">
          {saved === "saving"
            ? "Saving…"
            : saved === "saved"
              ? "Saved"
              : saved === "unsaved"
                ? "Not saved yet"
                : saved === "failed"
                  ? "Couldn't save. Trying again."
                  : ""}
        </span>
        <span className={s.viewSeg} role="radiogroup" aria-label="View">
          {(
            [
              ["build", "Build"],
              ["numbers", "Numbers"],
            ] as const
          ).map(([m, label]) => (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={mode === m}
              tabIndex={mode === m ? 0 : -1}
              disabled={aiLocked}
              onClick={() => setMode(m)}
              data-view={m}
              onKeyDown={(e) => {
                if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) {
                  e.preventDefault();
                  const next = mode === "build" ? "numbers" : "build";
                  setMode(next);
                  // Focus goes with the choice, as in any radio group.
                  requestAnimationFrame(() =>
                    document.querySelector<HTMLButtonElement>(`[data-view="${next}"]`)?.focus(),
                  );
                }
              }}
            >
              {label}
            </button>
          ))}
        </span>
        {mode === "numbers" && (
          <span className={s.range} role="status" title={statsSaid ?? undefined}>
            {statsSaid ?? (stats ? "Last 30 days" : "Counting…")}
          </span>
        )}
        <span className={s.right}>
          <button
            type="button"
            className={s.testBtn}
            aria-pressed={tool === "versions"}
            disabled={aiLocked}
            onClick={() => openTool(tool === "versions" ? null : "versions")}
            title="Versions"
          >
            <svg
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              aria-hidden
            >
              <circle cx="8" cy="8" r="5.5" />
              <path d="M8 5v3l2 1.5" />
            </svg>
            <span className={s.wide}>Versions</span>
          </button>
          <button
            type="button"
            className={s.testBtn}
            aria-pressed={tool === "test"}
            disabled={aiLocked}
            onClick={() => openTool(tool === "test" ? null : "test")}
            title="Test"
          >
            <svg
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinejoin="round"
              aria-hidden
            >
              <path d="M5 3.5v9l7-4.5z" />
            </svg>
            <span className={s.wide}>Test</span>
          </button>
          <button
            type="button"
            className={s.prob}
            disabled={aiLocked}
            data-ok={blocking === 0 || undefined}
            aria-expanded={showProblems}
            onClick={() => setShowProblems((v) => !v)}
          >
            {blocking === 0 ? (
              <>
                <span className={s.wide}>Ready to publish</span>
                <span className={s.narrowOnly} aria-hidden>
                  Ready
                </span>
              </>
            ) : blocking === 1 ? (
              "1 problem"
            ) : (
              `${blocking} problems`
            )}
          </button>
          <button
            type="button"
            className={s.publish}
            disabled={blocking > 0 || publishing || saved !== "saved" || aiLocked}
            title={saved !== "saved" ? "Publish waits until the flow is saved." : undefined}
            onClick={() => void publish()}
          >
            {view.status === "live" ? "Publish changes" : "Publish"}
          </button>
        </span>
      </header>

      {saved === "changed-elsewhere" && (
        <div role="alert" className={s.banner}>
          Someone else changed this flow meanwhile. Reload to see their changes; LUME won&apos;t save over
          them.
          <button type="button" onClick={() => window.location.reload()}>
            Reload
          </button>
        </div>
      )}
      {notice && (
        <div role="status" className={s.toast}>
          {notice}
          <button type="button" aria-label="Close" onClick={() => setNotice(null)}>
            ×
          </button>
        </div>
      )}

      <div
        ref={camera.hostRef}
        className={s.body}
        data-grabbing={camera.grabbing || undefined}
        tabIndex={0}
        role="region"
        aria-label="The flow's canvas"
      >
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onNodeDragStart={() => history.current.push(graphRef.current)}
          nodesDraggable={!aiLocked}
          nodesConnectable={!aiLocked}
          elementsSelectable={!aiLocked}
          panOnDrag={false}
          panOnScroll={false}
          zoomOnScroll={false}
          zoomOnPinch={false}
          zoomOnDoubleClick={false}
          preventScrolling={false}
          selectionOnDrag={false}
          deleteKeyCode={null}
          minZoom={0.2}
          maxZoom={3}
          onlyRenderVisibleElements={graph.nodes.length > 40}
          proOptions={{ hideAttribution: true }}
          className={s.rf}
        >
          <Background variant={BackgroundVariant.Dots} gap={22} size={1.3} className={s.dots} />
          <MiniMap
            className={s.mini}
            pannable={false}
            zoomable={false}
            nodeBorderRadius={4}
            onClick={(_, p) => camera.centerOn(p.x, p.y)}
            ariaLabel="Map of the flow"
          />
          {cursor && <AiCursor x={cursor.x} y={cursor.y} label={cursor.label} zoom={camera.zoom} />}
        </ReactFlow>

        <nav className={s.rail} aria-label="Add a step" data-tool>
          {RAIL.map((k) => (
            <button
              key={k}
              type="button"
              className={s.ibtn}
              aria-label={`Add ${KINDS[k].label}`}
              title={KINDS[k].label}
              disabled={aiLocked}
              onClick={() => add(k)}
            >
              <KindIcon d={KINDS[k].icon} />
            </button>
          ))}
        </nav>

        <div className={s.zoom} data-tool>
          <button type="button" className={s.ibtn} aria-label="Zoom out" onClick={camera.zoomOut}>
            −
          </button>
          <button type="button" className={s.z} aria-label="Zoom to 100%" onClick={camera.zoomReset}>
            {Math.round(camera.zoom * 100)}%
          </button>
          <button type="button" className={s.ibtn} aria-label="Zoom in" onClick={camera.zoomIn}>
            +
          </button>
          <button type="button" className={s.fit} onClick={fitAll}>
            Fit
          </button>
        </div>

        {aiPlan && (aiPhase === "playing" || aiPhase === "done") && (
          <PlanCard rows={aiPlan.rows} at={planAt} done={aiPhase === "done"} said={aiPlan.said} />
        )}
        {mode === "build" && (
          <AiBar
            phase={aiPhase}
            prompt={prompt}
            onPrompt={setPrompt}
            selecting={selected.some((x) => x !== START && !x.includes(">"))}
            doneWords={doneSay}
            beside={sidePanel && !aiLocked}
            marked={fresh.size > 0}
            onBuild={() => void buildWithAi()}
            onStop={stopAi}
            onKeep={keepAi}
            onDiscard={discardAi}
          />
        )}

        {tool === "replay" && (
          <ReplayPanel
            flowId={initial.id}
            graph={graph}
            onTool={openTool}
            onClose={() => openTool(null)}
            onLit={onLit}
          />
        )}
        {tool === "versions" && (
          <VersionsPanel
            // A Publish while it's open adds a version: it reads them again.
            key={`versions-${view.live?.version ?? 0}`}
            flowId={initial.id}
            onTool={openTool}
            onClose={() => openTool(null)}
            onRestore={restoreVersion}
            onCopy={copyVersion}
          />
        )}
        {tool === "test" && (
          <TestPanel
            graph={graph}
            businessName={businessName}
            catalog={catalog}
            byComment={view.triggers.some((t) => t.kind === "comment" && t.enabled)}
            onLit={onLit}
            onTool={openTool}
            onClose={() => openTool(null)}
          />
        )}
        {tool === null &&
          (() => {
            const one = selected.length === 1 ? graph.nodes.find((n) => n.id === selected[0]) : undefined;
            if (selected.length === 1 && selected[0] === START)
              return (
                <StartPanel
                  // Kept across its own save, so it can say "Saved."; its changes not saved yet live here.
                  key="start"
                  flowId={initial.id}
                  triggers={view.triggers}
                  draft={triggerDraft}
                  onDraft={onDraft}
                  onSave={saveTriggers}
                  onClose={() => setSelected([])}
                />
              );
            return one ? (
              <Inspector
                key={one.id}
                node={one}
                problems={issues.filter((p) => p.nodeId === one.id)}
                catalog={catalog}
                flows={flows.filter((f) => f.id !== initial.id)}
                onChange={editNode}
                onDelete={() => remove([one.id])}
                onClose={() => setSelected([])}
              />
            ) : null;
          })()}

        {showProblems && (
          <div className={s.probs} role="dialog" aria-label="Problems" data-tool>
            {issues.length === 0 ? (
              <p className={s.probsNone}>Nothing stops this flow going live.</p>
            ) : (
              issues.map((p, i) => (
                <div key={i} className={s.probRow} data-warning={p.warning || undefined}>
                  <span className={s.probText}>
                    <b>{p.words}</b>
                    {p.fix && <span>{p.fix}</span>}
                  </span>
                  {p.nodeId && (
                    <button type="button" onClick={() => showStep(p.nodeId!)}>
                      Show me
                    </button>
                  )}
                </div>
              ))
            )}
          </div>
        )}
      </div>

      <p className={s.narrow}>
        The builder needs a wider screen. Open LUME on a computer to change this flow.
      </p>
    </div>
  );
}

export type { GNode };
