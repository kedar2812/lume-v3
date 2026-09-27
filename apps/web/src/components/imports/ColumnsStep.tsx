"use client";
import { Button } from "@/components/ui/Button";
import type { DraftView } from "@/lib/imports/types";
import s from "./imports.module.css";

/** Step 2 (spec §9.2). Filled in by Task 11. */
export function ColumnsStep({
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
      <section className={s.body} aria-labelledby="import-columns-title">
        <h3 id="import-columns-title" className={s.stepTitle}>
          Match your columns
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
