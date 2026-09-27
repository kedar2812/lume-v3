"use client";
import { Button } from "@/components/ui/Button";
import type { DraftView } from "@/lib/imports/types";
import s from "./imports.module.css";

/** Step 3 (spec §9.3). Filled in by Task 12. */
export function RulesStep({
  draft,
  blocked,
  onContinue,
}: {
  draft: DraftView;
  onDraft(d: DraftView): void;
  blocked: boolean;
  onContinue(): void;
}) {
  return (
    <>
      <section className={s.body} aria-labelledby="import-rules-title">
        <h3 id="import-rules-title" className={s.stepTitle}>
          How to add them
        </h3>
      </section>
      <footer className={s.foot}>
        <Button variant="primary" disabled={blocked || !draft} onClick={onContinue}>
          Continue
        </Button>
      </footer>
    </>
  );
}
