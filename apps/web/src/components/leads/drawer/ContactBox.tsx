"use client";
import { useState } from "react";
import { useToast } from "@/components/feedback/ToastProvider";
import { leadsClient } from "@/lib/leads/client";
import type { Lead } from "@/lib/leads/types";
import s from "./drawer.module.css";

const ICON = {
  phone:
    "M4 2.5h2l1 3-1.5 1a8 8 0 0 0 4 4l1-1.5 3 1v2a1.5 1.5 0 0 1-1.6 1.5A11 11 0 0 1 2.5 4.1 1.5 1.5 0 0 1 4 2.5z",
  email: "M2.5 4.5h11v7h-11zM2.5 4.5 8 9l5.5-4.5",
  instagram:
    "M4.5 2.5h7a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-7a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2zM8 5.6a2.4 2.4 0 1 1 0 4.8 2.4 2.4 0 0 1 0-4.8zM11.3 4.6h.01",
} as const;
type Kind = keyof typeof ICON;
const LABEL: Record<Kind, string> = { phone: "Phone", email: "Email", instagram: "Instagram" };

/**
 * The lead's contact details. For a masked role each value is masked, and Reveal (report §12.2 #3) shows
 * the real ones for this lead only; the box says plainly that it was recorded.
 */
export function ContactBox({ lead, onRevealed }: { lead: Lead; onRevealed: () => void }) {
  const { toast } = useToast();
  const [revealed, setRevealed] = useState<Partial<Record<Kind, string | null>> | null>(null);
  const [busy, setBusy] = useState(false);
  const kinds = (["phone", "email", "instagram"] as Kind[]).filter((k) => lead[k] !== undefined);
  const present = kinds.filter((k) => lead[k]);

  const reveal = async () => {
    setBusy(true);
    const r = await leadsClient.reveal(lead.id);
    if (!r.ok) {
      setBusy(false);
      return toast({ tone: "danger", title: "LUME couldn’t reveal this contact", detail: r.message });
    }
    // A short blur while the real values swap in, so the change is felt rather than jumped.
    window.setTimeout(() => {
      setRevealed(r.data);
      setBusy(false);
      onRevealed();
    }, 260);
  };

  return (
    <section className={s.box} aria-label="Contact">
      <h3 className={s.boxTitle}>
        Contact
        {lead.contactMasked && !revealed && <span>masked for your role</span>}
      </h3>
      {present.length === 0 && <p className={s.none}>No contact details</p>}
      {present.map((k) => {
        const shown = revealed ? (revealed[k] ?? lead[k]!.display) : lead[k]!.display;
        return (
          <div key={k} className={s.cv}>
            <svg
              viewBox="0 0 16 16"
              width="15"
              height="15"
              aria-label={LABEL[k]}
              role="img"
              className={s.cvIcon}
            >
              <path d={ICON[k]} fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
            </svg>
            <span className={s.cvValue} data-blur={busy || undefined}>
              {shown}
            </span>
          </div>
        );
      })}
      {lead.can.reveal && lead.contactMasked && !revealed && present.length > 0 && (
        <button type="button" className={s.reveal} onClick={() => void reveal()} disabled={busy}>
          Reveal contact
        </button>
      )}
      {revealed && <p className={s.recorded}>Revealed · recorded in the audit log</p>}
    </section>
  );
}
