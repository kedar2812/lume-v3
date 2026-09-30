"use client";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Alert } from "@/lib/alerts";
import { api, CHANGED } from "@/lib/client";

/** Each kind of alert's icon (the canvas's), in a 16×16 box. */
const ICONS: Record<string, string> = {
  late: "M8 14.5a6.5 6.5 0 100-13 6.5 6.5 0 000 13zM8 4.8v3.8M8 11.2h.01",
  quiet: "M8 14.5a6.5 6.5 0 100-13 6.5 6.5 0 000 13zM8 4.5V8l2.2 1.4",
  due: "M2.5 5.5h11M5 1.5v2.5M11 1.5v2.5M3.5 3.5h9a1 1 0 011 1v8a1 1 0 01-1 1h-9a1 1 0 01-1-1v-8a1 1 0 011-1z",
  trial: "M3 13.5V2.5M3 3h8l-1.5 2.5L11 8H3",
  old: "M8 2v8M4.5 6.5L8 10l3.5-3.5M2.5 13.5h11",
};
const words = (n: number) =>
  n === 0 ? "Nothing needs a look" : n === 1 ? "1 thing needs a look" : `${n} things need a look`;

/** "Needs a look" (spec §4.4): late payments, quiet servers, payments due, trials ending, old versions. */
export function Bell() {
  const [alerts, setAlerts] = useState<Alert[] | null>(null);
  const [open, setOpen] = useState(false);
  const [ring, setRing] = useState(0);
  const button = useRef<HTMLButtonElement>(null);

  const load = useCallback(async () => {
    const r = await api.get<{ alerts: Alert[] }>("/api/alerts");
    if (r.ok) setAlerts(r.data.alerts);
  }, []);
  useEffect(() => {
    void load();
    const again = () => void load();
    window.addEventListener(CHANGED, again);
    return () => window.removeEventListener(CHANGED, again);
  }, [load]);
  useEffect(() => {
    if (!open) return;
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        button.current?.focus();
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [open]);

  const hide = async (body: { id: string } | { all: true }) => {
    const r = await api.post<{ alerts: Alert[] }>("/api/alerts/dismiss", body);
    if (r.ok) setAlerts(r.data.alerts);
  };
  const list = alerts ?? [];
  const n = list.length;

  return (
    <span className="bellwrap">
      <button
        ref={button}
        type="button"
        className="bellbtn"
        aria-label={alerts === null ? "Needs a look" : words(n)}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => {
          if (!open) setRing((x) => x + 1);
          setOpen(!open);
        }}
      >
        <svg
          key={ring}
          className={ring ? "bell ring" : "bell"}
          width="19"
          height="19"
          viewBox="0 0 30 30"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.3"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <path d="M8 20V13a7 7 0 0114 0v7l2 2.5H6z" />
          <path d="M12.5 25.5a2.7 2.7 0 005 0" />
        </svg>
        {n > 0 && (
          <span className="badge num" aria-hidden>
            {n}
          </span>
        )}
      </button>
      {open && (
        <>
          <span className="catcher" onClick={() => setOpen(false)} aria-hidden />
          <div className="pop" role="dialog" aria-label="Needs a look">
            <div className="pophead">
              <span>
                Needs a look
                {n > 0 && <span className="count num">{n}</span>}
              </span>
              {n > 0 && (
                <button type="button" className="link" onClick={() => void hide({ all: true })}>
                  Hide all
                </button>
              )}
            </div>
            {n > 0 ? (
              <ul className="alerts">
                {list.map((a, i) => (
                  <li
                    key={a.id}
                    className={`alert tone-${a.tone}`}
                    style={{ animationDelay: `${0.06 + i * 0.05}s` }}
                  >
                    <span className="ico toned" aria-hidden>
                      <svg
                        width="15"
                        height="15"
                        viewBox="0 0 16 16"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.7"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <path d={ICONS[a.id.split(":")[0]!] ?? ICONS.late} />
                      </svg>
                    </span>
                    <div className="words">
                      <strong>{a.title}</strong>
                      <span>{a.body}</span>
                      {a.clientId && a.clientName && (
                        <Link href={`/clients/${a.clientId}`} onClick={() => setOpen(false)}>
                          Open {a.clientName}
                        </Link>
                      )}
                    </div>
                    <button
                      type="button"
                      className="x"
                      aria-label={`Hide: ${a.title}`}
                      onClick={() => void hide({ id: a.id })}
                    >
                      <svg
                        width="12"
                        height="12"
                        viewBox="0 0 12 12"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.6"
                        strokeLinecap="round"
                        aria-hidden
                      >
                        <path d="M3 3l6 6M9 3l-6 6" />
                      </svg>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="clear">
                <span className="okpop" aria-hidden>
                  <svg
                    width="20"
                    height="20"
                    viewBox="0 0 16 16"
                    fill="none"
                    stroke="var(--greenInk)"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M3.5 8.5l3 3 6-7" />
                  </svg>
                </span>
                <strong>All clear</strong>
                <span>LUME rings the bell when a client needs you.</span>
              </div>
            )}
          </div>
        </>
      )}
    </span>
  );
}
