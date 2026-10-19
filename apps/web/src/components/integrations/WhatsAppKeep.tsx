"use client";
import { bytesText } from "@lume/core/shared";
import { useState } from "react";
import { useToast } from "@/components/feedback/ToastProvider";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import type { IntegrationsView } from "@/lib/sheets/types";
import { whatsappClient } from "@/lib/whatsapp/client";
import type { KeepMonths, KeepPreview } from "@/lib/whatsapp/types";
import s from "./integrations.module.css";

const CHOICES: { value: KeepMonths; label: string }[] = [
  { value: null, label: "Forever" },
  { value: 24, label: "2 years" },
  { value: 12, label: "1 year" },
  { value: 6, label: "6 months" },
  { value: 3, label: "3 months" },
];
const labelOf = (m: KeepMonths) => CHOICES.find((c) => c.value === m)?.label ?? "Forever";
/** Shorter than now: files would go. Forever is the longest. */
const shorter = (to: KeepMonths, from: KeepMonths) => to !== null && (from === null || to < from);

/**
 * "Keep WhatsApp files" on the WhatsApp card (2026-10-19): forever by default. A shorter window asks first, saying how
 * many files go and about how much room that frees, and that they don't come back (Meta's links expire, so LUME can't
 * fetch them again). They stay on the phone. A longer window, or forever, is saved at once.
 */
export function WhatsAppKeep({ months, onView }: { months: KeepMonths; onView(v: IntegrationsView): void }) {
  const { toast } = useToast();
  const [asking, setAsking] = useState<{ to: Exclude<KeepMonths, null>; preview: KeepPreview } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async (to: KeepMonths) => {
    setBusy(true);
    setError(null);
    const r = await whatsappClient.setKeepFiles(to);
    setBusy(false);
    if (!r.ok) return setError(r.message);
    setAsking(null);
    onView(r.data);
    toast({
      tone: "ok",
      title: to === null ? "WhatsApp files are kept forever" : `WhatsApp files are kept for ${labelOf(to)}`,
    });
  };
  const choose = async (raw: string) => {
    const to = (raw === "" ? null : Number(raw)) as KeepMonths;
    if (to === months) return;
    // Longer, or forever: nothing goes, so nothing to ask. (`to === null` again only so TypeScript knows it's a number.)
    if (!shorter(to, months) || to === null) return void (await save(to));
    setBusy(true);
    setError(null);
    const p = await whatsappClient.keepPreview(to);
    setBusy(false);
    if (!p.ok) return setError(p.message);
    if (p.data.files === 0) return void (await save(to));
    setAsking({ to, preview: p.data });
  };

  return (
    <div className={s.waKeep}>
      <label className={s.waOwner}>
        <span>Keep WhatsApp files</span>
        <select
          aria-label="Keep WhatsApp files"
          value={months ?? ""}
          disabled={busy}
          onChange={(e) => void choose(e.target.value)}
        >
          {CHOICES.map((c) => (
            <option key={c.label} value={c.value ?? ""}>
              {c.label}
            </option>
          ))}
        </select>
      </label>
      <p className={s.waKeepNote}>
        {months === null
          ? "Photos, voice notes and documents stay in LUME as long as their lead does."
          : "Older files go from LUME. They stay on the phone."}
      </p>
      {error && (
        <p role="alert" className={s.error}>
          {error}
        </p>
      )}
      {asking && (
        <Dialog label={`Keep WhatsApp files for ${labelOf(asking.to)}?`} onClose={() => setAsking(null)}>
          <div className={s.waSheet}>
            <h2 className={s.waSheetTitle}>Keep WhatsApp files for {labelOf(asking.to)}?</h2>
            <p className={s.waSheetText}>
              LUME removes {asking.preview.files} {asking.preview.files === 1 ? "file" : "files"} older than
              that
              {asking.preview.bytes > 0 ? `, about ${bytesText(asking.preview.bytes)}` : ""}, within the hour.
              The messages stay on their leads, and the files stay on the phone.
            </p>
            <p className={s.waSheetText}>
              Files LUME removes don’t come back, even if you keep files longer later.
            </p>
            <div className={s.waSheetFoot}>
              <Button variant="ghost" onClick={() => setAsking(null)}>
                Cancel
              </Button>
              <Button variant="danger" loading={busy} onClick={() => void save(asking.to)}>
                Remove older files
              </Button>
            </div>
          </div>
        </Dialog>
      )}
    </div>
  );
}
