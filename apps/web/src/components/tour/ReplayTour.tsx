"use client";
import { Button } from "@/components/ui/Button";
import { useTour } from "./TourProvider";
import s from "./tour.module.css";

/** Settings' Help card: the tour, any time. */
export function ReplayTour() {
  const { start } = useTour();
  return (
    <div className={s.help}>
      <div>
        <h2>Help</h2>
        <p>A two-minute walk through the places you use most.</p>
      </div>
      <Button onClick={start}>Replay the tour</Button>
    </div>
  );
}
