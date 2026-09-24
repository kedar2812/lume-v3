import type { OnboardingStep } from "@lume/core/shared";
import s from "./onboarding.module.css";

const GROUP_LABEL: Partial<Record<OnboardingStep["group"], string>> = {
  you: "Just you",
  workspace: "Your workspace",
};

/**
 * The step list. Done steps show a tick and can be revisited; the current one is marked; later ones,
 * and everything past an unfinished required step, are disabled.
 */
export function Rail({
  steps,
  index,
  reached,
  lockedAfter,
  businessName,
  onJump,
}: {
  steps: OnboardingStep[];
  index: number;
  reached: number;
  /** Index of an unfinished required step; nothing after it can be reached. */
  lockedAfter: number;
  businessName: string;
  onJump: (i: number) => void;
}) {
  return (
    <aside className={s.rail}>
      <div className={s.who}>
        <img src="/lume-mark.png" alt="" />
        <div>
          <b>LUME</b>
          <span>{businessName}</span>
        </div>
      </div>
      <nav aria-label="Onboarding steps" className={s.steps}>
        {steps.map((step, i) => {
          const group = GROUP_LABEL[step.group];
          const newGroup = group && steps[i - 1]?.group !== step.group;
          const state = i === index ? "on" : i < reached ? "done" : "todo";
          return (
            <div key={step.id}>
              {newGroup && (
                <p className={s.grp} aria-hidden>
                  {group}
                </p>
              )}
              <button
                type="button"
                className={s.st}
                data-state={state}
                aria-current={i === index ? "step" : undefined}
                disabled={i > reached || i > lockedAfter}
                onClick={() => onJump(i)}
              >
                <span className={s.circle} aria-hidden>
                  <svg viewBox="0 0 12 12" width="10" height="10">
                    <path
                      d="M2.5 6.2 5 8.5l4.5-5"
                      fill="none"
                      stroke="#fff"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </span>
                {step.title}
                {step.required && <span className={s.req}>Required</span>}
              </button>
            </div>
          );
        })}
      </nav>
      <p className={s.railFoot}>Everything here stays editable in Settings.</p>
    </aside>
  );
}
