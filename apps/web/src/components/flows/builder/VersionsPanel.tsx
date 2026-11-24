"use client";
import { useCallback, useEffect, useState } from "react";
import { flowsClient, type FlowVersion } from "@/lib/flows/client";
import { PanelHead, type Tool } from "./PanelHead";
import b from "./builder.module.css";
import p from "./panels.module.css";

const when = new Intl.DateTimeFormat("en-IN", {
  day: "numeric",
  month: "short",
  hour: "numeric",
  minute: "2-digit",
});
const steps = (n: number) => (n === 1 ? "1 step" : `${n.toLocaleString("en-IN")} steps`);

/**
 * Versions (plan 2026-11-23-flow-builder, Task B4; board BuilderTest): every time the flow went live, what changed in
 * it, and one brought back into the draft (Undo takes it back) or copied as a new flow. What's live changes only when
 * the flow is published again.
 */
export function VersionsPanel({
  flowId,
  onTool,
  onClose,
  onRestore,
  onCopy,
}: {
  flowId: string;
  onTool: (t: Tool) => void;
  onClose: () => void;
  onRestore: (v: FlowVersion) => Promise<{ ok: boolean; message?: string }>;
  onCopy: (v: FlowVersion) => Promise<{ ok: boolean; message?: string }>;
}) {
  const [list, setList] = useState<FlowVersion[] | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [pick, setPick] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState("");

  const load = useCallback(async () => {
    setFailed(null);
    const r = await flowsClient.versions(flowId);
    if (!r.ok) {
      setFailed(r.message);
      return;
    }
    setList(r.data.versions);
    setPick((x) => x ?? r.data.versions[0]?.id ?? null);
  }, [flowId]);
  useEffect(() => {
    void load();
  }, [load]);

  const one = list?.find((v) => v.id === pick) ?? null;
  // The oldest one listed is the first only when the whole history fits in the list.
  const first = !!one && !!list && list.at(-1) === one && list.length < 50;
  const act = async (f: typeof onRestore, v: FlowVersion, done: string) => {
    setBusy(true);
    setSaid("");
    const r = await f(v);
    setBusy(false);
    setSaid(r.ok ? done : (r.message ?? "LUME couldn't do that. Try again."));
  };

  return (
    <aside className={b.insp} aria-label="Versions" data-tool>
      <PanelHead tool="versions" onTool={onTool} onClose={onClose} />
      <div className={p.body}>
        <p className={p.title}>Every time it went live.</p>
        {failed ? (
          <>
            <p className={p.said}>{failed}</p>
            <div className={p.acts}>
              <button type="button" className={b.ghostBtnPlain} onClick={() => void load()}>
                Try again
              </button>
            </div>
          </>
        ) : list === null ? (
          <div aria-busy="true" aria-label="Loading the versions">
            <div className={p.skel} />
          </div>
        ) : list.length === 0 ? (
          <p className={p.cap}>
            Nothing has gone live yet. Each Publish is kept here, to look back at or bring back.
          </p>
        ) : (
          <>
            <div
              role="list"
              aria-label="Versions"
              style={{ display: "flex", flexDirection: "column", gap: 6 }}
            >
              {list.map((v) => (
                <div role="listitem" key={v.id} style={{ display: "flex", flexDirection: "column" }}>
                  <button
                    type="button"
                    className={p.ver}
                    aria-pressed={v.id === pick}
                    onClick={() => {
                      setPick(v.id);
                      setSaid("");
                    }}
                  >
                    <span className={p.vt}>
                      <b>Version {v.version.toLocaleString("en-IN")}</b>
                      <span>
                        {when.format(new Date(v.createdAt))}
                        {v.createdBy?.name ? ` · ${v.createdBy.name}` : ""}
                      </span>
                    </span>
                    {v.live && <span className={p.pill}>Live</span>}
                  </button>
                </div>
              ))}
            </div>
            {one && (
              <div className={p.diff}>
                <span className={b.lbl}>
                  {first ? `Version ${one.version}: the first` : `What changed in version ${one.version}`}
                </span>
                {first ? (
                  <div className={p.dr} data-sign="add">
                    <i>+</i>
                    <span>{steps(one.changes.added)}</span>
                  </div>
                ) : one.changes.added + one.changes.removed + one.changes.changed === 0 ? (
                  <div className={p.dr}>
                    <i>·</i>
                    <span>No step changed (only where they sit, or what starts it)</span>
                  </div>
                ) : (
                  <>
                    {one.changes.added > 0 && (
                      <div className={p.dr} data-sign="add">
                        <i>+</i>
                        <span>{steps(one.changes.added)} added</span>
                      </div>
                    )}
                    {one.changes.removed > 0 && (
                      <div className={p.dr} data-sign="remove">
                        <i>−</i>
                        <span>{steps(one.changes.removed)} taken out</span>
                      </div>
                    )}
                    {one.changes.changed > 0 && (
                      <div className={p.dr}>
                        <i>~</i>
                        <span>{steps(one.changes.changed)} changed</span>
                      </div>
                    )}
                  </>
                )}
              </div>
            )}
            {one && (
              <div className={p.acts}>
                <button
                  type="button"
                  className={b.saveBtn}
                  disabled={busy}
                  onClick={() =>
                    void act(
                      onRestore,
                      one,
                      `Version ${one.version} is in the draft now. Undo takes it back.`,
                    )
                  }
                >
                  Restore into the draft
                </button>
                <button
                  type="button"
                  className={b.ghostBtnPlain}
                  disabled={busy}
                  onClick={() => void act(onCopy, one, "Opening the copy…")}
                >
                  Copy as a new flow
                </button>
              </div>
            )}
            <p className={p.said} role="status">
              {said}
            </p>
            <p className={p.cap}>
              Every Publish is kept. Restoring puts that version in the draft; the live flow changes only when
              you publish again.
            </p>
          </>
        )}
      </div>
    </aside>
  );
}
