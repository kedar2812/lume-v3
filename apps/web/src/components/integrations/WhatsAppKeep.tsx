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
 * Choosing how long chat files stay (WhatsApp's and Instagram's, one setting: the WhatsApp card and Settings › Storage
 * both set it). Forever by default. A shorter window asks first, saying how many files go and about how much room
 * that frees, and that they don't come back (Meta's links expire, so LUME can't fetch them again); they stay on the
 * phone or in Instagram. A longer window, or forever, is saved at once. Each place saves through its own call.
 */
export function useKeepChoice(o: {
  months: KeepMonths;
  save(to: KeepMonths): Promise<{ ok: boolean; message?: string }>;
}) {
  const { toast } = useToast();
  const [asking, setAsking] = useState<{ to: Exclude<KeepMonths, null>; preview: KeepPreview } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async (to: KeepMonths) => {
    setBusy(true);
    setError(null);
    const r = await o.save(to);
    setBusy(false);
    if (!r.ok) return setError(r.message ?? "LUME couldn't save that. Try again.");
    setAsking(null);
    toast({
      tone: "ok",
      title: to === null ? "Chat files are kept forever" : `Chat files are kept for ${labelOf(to)}`,
    });
  };
  const choose = async (raw: string) => {
    const to = (raw === "" ? null : Number(raw)) as KeepMonths;
    if (to === o.months) return;
    // Longer, or forever: nothing goes, so nothing to ask. (`to === null` again only so TypeScript knows it's a number.)
    if (!shorter(to, o.months) || to === null) return void (await save(to));
    setBusy(true);
    setError(null);
    const p = await whatsappClient.keepPreview(to);
    setBusy(false);
    if (!p.ok) return setError(p.message);
    if (p.data.files === 0) return void (await save(to));
    setAsking({ to, preview: p.data });
  };
  const dialog = asking && (
    <Dialog label={`Keep chat files for ${labelOf(asking.to)}?`} onClose={() => setAsking(null)}>
      <div className={s.waSheet}>
        <h2 className={s.waSheetTitle}>Keep chat files for {labelOf(asking.to)}?</h2>
        <p className={s.waSheetText}>
          LUME removes {asking.preview.files.toLocaleString("en-IN")}{" "}
          {asking.preview.files === 1 ? "file" : "files"} older than that
          {asking.preview.bytes > 0 ? `, about ${bytesText(asking.preview.bytes)}` : ""}, within the hour. The
          messages stay on their leads, and the files stay on the phone or in Instagram.
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
  );
  return { choose, busy, error, dialog };
}

export const KEEP_CHOICES = CHOICES;

/** "Keep chat files" on the WhatsApp card (2026-10-19; Instagram's too since 2026-11-23). */
export function WhatsAppKeep({ months, onView }: { months: KeepMonths; onView(v: IntegrationsView): void }) {
  const k = useKeepChoice({
    months,
    save: async (to) => {
      const r = await whatsappClient.setKeepFiles(to);
      if (r.ok) onView(r.data);
      return r.ok ? { ok: true } : { ok: false, message: r.message };
    },
  });
  return (
    <div className={s.waKeep}>
      <label className={s.waOwner}>
        <span>Keep chat files</span>
        <select
          aria-label="Keep chat files"
          value={months ?? ""}
          disabled={k.busy}
          onChange={(e) => void k.choose(e.target.value)}
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
          : "Older WhatsApp and Instagram files go from LUME. They stay on the phone or in Instagram."}
      </p>
      {k.error && (
        <p role="alert" className={s.error}>
          {k.error}
        </p>
      )}
      {k.dialog}
    </div>
  );
}
