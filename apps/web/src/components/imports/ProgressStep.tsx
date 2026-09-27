"use client";
import type { ImportView } from "@/lib/imports/types";
import s from "./imports.module.css";

/** Step 5 (spec §9.5). Filled in by Task 13. */
export function ProgressStep({ initial }: { initial: ImportView; onClose(): void }) {
  return (
    <section className={s.body} aria-labelledby="import-run-title">
      <h3 id="import-run-title" className={s.stepTitle}>
        Importing {initial.fileName}
      </h3>
    </section>
  );
}
