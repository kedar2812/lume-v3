import Link from "next/link";
import { ago } from "@/lib/sheets/format";
import type { SheetSourceView, SheetStatus } from "@/lib/sheets/types";
import s from "./integrations.module.css";

const STATUS: Record<SheetStatus, string> = {
  active: "Active",
  paused: "Paused",
  needs_attention: "Needs attention",
};
const n = (v: number) => v.toLocaleString("en");

/** "Checked 2 min ago · 12 new today · 1 problem": is it working, and is it bringing leads? */
function health(v: SheetSourceView): string {
  const parts = [
    v.syncing ? "Checking now" : v.lastSyncedAt ? `Checked ${ago(v.lastSyncedAt)}` : "Not checked yet",
    `${n(v.newToday)} new today`,
    v.problems ? `${n(v.problems)} ${v.problems === 1 ? "problem" : "problems"}` : null,
  ];
  return parts.filter(Boolean).join(" · ");
}

export function SheetSourceList({ sources }: { sources: SheetSourceView[] }) {
  if (!sources.length)
    return <p className={s.empty}>No sheets yet. Add one, and its new rows become leads on their own.</p>;
  return (
    <ul className={s.sources}>
      {sources.map((v) => (
        <li key={v.id}>
          <Link href={`/settings/integrations/${v.id}`} className={s.source}>
            <span className={s.sourceName}>{v.name}</span>
            <span className={s.sourceMeta}>
              {v.failing ? "LUME hasn't reached Google for a while" : health(v)}
            </span>
            <span className={s.pill} data-status={v.failing ? "failing" : v.status}>
              {STATUS[v.status]}
            </span>
            <svg className={s.chev} viewBox="0 0 12 12" width="12" height="12" aria-hidden>
              <path
                d="M4.5 2.5 8 6l-3.5 3.5"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </Link>
        </li>
      ))}
    </ul>
  );
}
