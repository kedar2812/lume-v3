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
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useReducedMotion } from "motion/react";
import type { FlowGraph, GNode } from "@lume/core/shared";
import { api } from "@/lib/api";
import { flowsClient, type FlowView } from "@/lib/flows/client";
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
import type { Catalog } from "@/lib/leads/types";
import s from "./builder.module.css";

/** Where Starts when sits, kept with the steps' places. */
export const START = "_start";
const NODE_W = 244;
const SAVE_MS = 800;
const nodeTypes = { step: StepCard, start: StartCard };
const newId = () => Math.random().toString(36).slice(2, 10);

type Saved = "saved" | "saving" | "unsaved" | "changed-elsewhere" | "failed";

/** The flow builder (plan 2026-11-23-flow-builder, Part B; approved canvas KJJDFJ7wddubXwRuked4m9, board Builder). */
type Props = { initial: FlowView; catalog: Catalog; flows: FlowChoice[] };

export function Builder(p: Props) {
  return (
    <ReactFlowProvider>
      <BuilderInner {...p} />
    </ReactFlowProvider>
  );
}

function BuilderInner({ initial, catalog, flows }: Props) {
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
  const history = useRef(new History(100));
  const clip = useRef<string[]>([]);
  const camera = useCamera({ reduce });

  // The truth, outside React's updaters (which must stay pure: review 2026-11-24): the graph on screen, the last graph
  // the server has, the version it's at, and the save pipeline (one at a time).
  const graphRef = useRef(initial.graph);
  const savedGraph = useRef(initial.graph);
  const rev = useRef(initial.rev);
  const inFlight = useRef(false);
  const again = useRef(false);
  const conflict = useRef(false);
  const holding = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const failures = useRef(0);
  /** Gone from the screen: nothing more is saved from here (the way-out send covers the last edit). */
  const gone = useRef(false);
  const scheduleRef = useRef<() => void>(() => undefined);

  /** Saves the graph on screen; one at a time; an edit during a save is saved right after, with the new version. */
  const flush = useCallback(async () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    if (conflict.current || holding.current || gone.current) return;
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
      if (unsaved() || inFlight.current) e.preventDefault();
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

  const problemsBy = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of issues) if (p.nodeId && !p.warning) m.set(p.nodeId, (m.get(p.nodeId) ?? 0) + 1);
    return m;
  }, [issues]);

  // Each card's data kept while its step and its problems are the same, so a drag re-renders only what moved.
  const dataCache = useRef(new Map<string, { node: GNode; problems: number; data: StepNode["data"] }>());
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
      let hit = cache.get(n.id);
      if (!hit || hit.node !== n || hit.problems !== problems) {
        hit = { node: n, problems, data: { node: n, problems } };
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
  }, [graph, view.triggers, selected, problemsBy]);

  const edges = useMemo<Edge[]>(
    () =>
      linesOf(graph).map((l) => ({
        id: l.id,
        source: l.from === "start" ? START : l.from,
        sourceHandle: l.exit,
        target: l.to,
        targetHandle: "in",
        selected: selected.includes(l.id),
      })),
    [graph, selected],
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

  const blocking = problems.length;
  /** Publish what's saved: autosave waits meanwhile, so the version both use is one and the same. */
  const publish = async () => {
    holding.current = true;
    setPublishing(true);
    const r = await flowsClient.publish(initial.id, rev.current);
    setPublishing(false);
    holding.current = false;
    if (r.ok) {
      rev.current = r.data.rev;
      setView(r.data);
      setNotice(`Version ${r.data.live?.version ?? ""} is live.`);
    } else if (r.status === 409) {
      conflict.current = true;
      setSaved("changed-elsewhere");
    } else setNotice(r.message);
    // An edit made while it published is saved now, with the version Publish left.
    if (!gone.current && graphRef.current !== savedGraph.current) schedule();
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
        <span className={s.right}>
          <button
            type="button"
            className={s.prob}
            data-ok={blocking === 0 || undefined}
            aria-expanded={showProblems}
            onClick={() => setShowProblems((v) => !v)}
          >
            {blocking === 0 ? "Ready to publish" : blocking === 1 ? "1 problem" : `${blocking} problems`}
          </button>
          <button
            type="button"
            className={s.publish}
            disabled={blocking > 0 || publishing || saved !== "saved"}
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
        </ReactFlow>

        <nav className={s.rail} aria-label="Add a step" data-tool>
          {RAIL.map((k) => (
            <button
              key={k}
              type="button"
              className={s.ibtn}
              aria-label={`Add ${KINDS[k].label}`}
              title={KINDS[k].label}
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

        {(() => {
          const one = selected.length === 1 ? graph.nodes.find((n) => n.id === selected[0]) : undefined;
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
