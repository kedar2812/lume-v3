"use client";
import { useRef, type KeyboardEvent } from "react";
import b from "./builder.module.css";
import p from "./panels.module.css";

/** The builder's side panel for the flow as a whole (approved canvas board BuilderTest): Test, Replay, Versions. */
export type Tool = "test" | "replay" | "versions";
const TOOLS: [Tool, string][] = [
  ["test", "Test"],
  ["replay", "Replay"],
  ["versions", "Versions"],
];
export const TOOL_NAMES: Record<Tool, string> = { test: "Test", replay: "Replay", versions: "Versions" };

/** The panel's head: what it shows (one of three, arrow keys move between them, as a radio group does) and Close. */
export function PanelHead({
  tool,
  onTool,
  onClose,
}: {
  tool: Tool;
  onTool: (t: Tool) => void;
  onClose: () => void;
}) {
  const group = useRef<HTMLSpanElement>(null);
  const onKey = (e: KeyboardEvent) => {
    const step =
      e.key === "ArrowRight" || e.key === "ArrowDown"
        ? 1
        : e.key === "ArrowLeft" || e.key === "ArrowUp"
          ? -1
          : 0;
    if (!step) return;
    e.preventDefault();
    const i = TOOLS.findIndex(([t]) => t === tool);
    const next = TOOLS[(i + step + TOOLS.length) % TOOLS.length]![0];
    onTool(next);
    // Each tab is its own panel: this head goes with the old one, so the new head's tab is found in the page.
    requestAnimationFrame(() =>
      document.querySelector<HTMLButtonElement>(`[data-tool-tab="${next}"]`)?.focus(),
    );
  };
  return (
    <div className={b.ih}>
      <span
        ref={group}
        className={p.seg}
        role="radiogroup"
        aria-label="What this panel shows"
        onKeyDown={onKey}
      >
        {TOOLS.map(([t, label]) => (
          <button
            key={t}
            type="button"
            role="radio"
            aria-checked={tool === t}
            tabIndex={tool === t ? 0 : -1}
            data-tool-tab={t}
            onClick={() => onTool(t)}
          >
            {label}
          </button>
        ))}
      </span>
      <button type="button" className={b.x} aria-label="Close" onClick={onClose}>
        ×
      </button>
    </div>
  );
}
