"use client";
import { useState } from "react";
import { useToast } from "@/components/feedback/ToastProvider";
import { ICON_SIZE, UI_ICONS } from "@/components/ui/icons";
import { leadsClient } from "@/lib/leads/client";
import type { Lead } from "@/lib/leads/types";
import s from "./drawer.module.css";
import { NearLimitNotice } from "@/components/security/NearLimitNotice";

/** Each contact's mark (docs/design/icons.md): the registry's, and Instagram's own logo. */
const ICON = { phone: UI_ICONS.call, email: UI_ICONS.email, instagram: null } as const;
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
      // Paused (6A): the app is already on its way to the paused card; nothing to add here.
      if (r.code === "SUSPENDED") return;
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
      {/* Near a watch limit (6A): one calm line, once an hour. */}
      <NearLimitNotice />
      {present.length === 0 && <p className={s.none}>No contact details</p>}
      {present.map((k) => {
        const shown = revealed ? (revealed[k] ?? lead[k]!.display) : lead[k]!.display;
        return (
          <div key={k} className={s.cv}>
            {(() => {
              const Mark = ICON[k];
              return Mark ? (
                <Mark size={ICON_SIZE.md} aria-label={LABEL[k]} role="img" className={s.cvIcon} />
              ) : (
                <img
                  src="/brand/instagram.png"
                  alt={LABEL[k]}
                  width={ICON_SIZE.md}
                  height={ICON_SIZE.md}
                  className={s.cvIcon}
                />
              );
            })()}
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
