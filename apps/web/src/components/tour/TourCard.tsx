import { forwardRef } from "react";
import { boldParts, type TourStep } from "@lume/core/shared";
import { Button } from "@/components/ui/Button";
import s from "./tour.module.css";

type Props = {
  step: TourStep;
  index: number;
  total: number;
  position: { top: number; left: number } | null;
  onBack: () => void;
  onNext: () => void;
  onSkip: () => void;
};

/**
 * The coach card. Not modal: the app stays readable around it. Module names in the copy are bold, and
 * the copy is only ever split into text runs, never parsed as HTML.
 */
export const TourCard = forwardRef<HTMLDivElement, Props>(function TourCard(
  { step, index, total, position, onBack, onNext, onSkip },
  ref,
) {
  const last = index === total - 1;
  return (
    <div
      ref={ref}
      role="dialog"
      aria-modal="false"
      aria-label="LUME tour"
      aria-describedby="tour-body"
      tabIndex={-1}
      className={s.card}
      data-placed={position ? "true" : undefined}
      style={position ? { top: position.top, left: position.left } : undefined}
    >
      <p className={s.kicker}>
        <span>
          {index + 1} of {total}
        </span>
        <span className={s.esc}>Esc to skip</span>
      </p>
      <h2 className={s.title}>{step.title}</h2>
      <p className={s.body} id="tour-body">
        {boldParts(step.body).map((p, i) =>
          p.bold ? <strong key={i}>{p.text}</strong> : <span key={i}>{p.text}</span>,
        )}
      </p>
      <span className={s.bar} aria-hidden>
        <i style={{ transform: `scaleX(${(index + 1) / total})` }} />
      </span>
      <div className={s.foot}>
        <Button variant="ghost" size="sm" onClick={onBack} disabled={index === 0}>
          Back
        </Button>
        <span className={s.right}>
          {!last && (
            <Button variant="ghost" size="sm" onClick={onSkip}>
              Skip tour
            </Button>
          )}
          <Button variant="primary" size="sm" onClick={onNext}>
            {last ? "Done" : "Next"}
          </Button>
        </span>
      </div>
    </div>
  );
});
