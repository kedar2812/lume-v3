import type { ReactNode } from "react";
import s from "../onboarding.module.css";

/** Every panel opens the same way: where you are, what this is, and why it matters. */
export function PanelHead({ kicker, title, lead }: { kicker: string; title: string; lead: ReactNode }) {
  return (
    <>
      <p className={s.kicker}>{kicker}</p>
      {/* Focus lands here on each step, so a screen reader announces the new step (never a visible ring). */}
      <h1 className={s.title} tabIndex={-1}>
        {title}
      </h1>
      <p className={s.lead}>{lead}</p>
    </>
  );
}
