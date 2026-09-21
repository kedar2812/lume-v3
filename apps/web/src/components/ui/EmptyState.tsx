import type { ReactNode } from "react";
import s from "./EmptyState.module.css";

/** Every empty state explains the next action (report §16.2). */
export function EmptyState({ title, body, action }: { title: string; body: string; action?: ReactNode }) {
  return (
    <div className={s.empty}>
      <img src="/lume-mark.png" alt="" />
      <h2>{title}</h2>
      <p>{body}</p>
      {action && <div className={s.action}>{action}</div>}
    </div>
  );
}
