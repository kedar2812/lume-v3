"use client";
import type { DraftView, ImportView } from "@/lib/imports/types";
import type { Step } from "./ImportSheet";
import s from "./imports.module.css";

/** Step 4 (spec §9.4). Filled in by Task 12. */
export function PreviewStep({
  draft,
}: {
  draft: DraftView;
  onFix(to: Step): void;
  onStarted(v: ImportView): void;
}) {
  return (
    <section className={s.body} aria-labelledby="import-preview-title">
      <h3 id="import-preview-title" className={s.stepTitle}>
        Preview {draft.fileName}
      </h3>
    </section>
  );
}
