"use client";
import { useEffect } from "react";
import { useSound } from "@/components/feedback/SoundProvider";
import { Button } from "@/components/ui/Button";
import type { KeyLicence } from "@/lib/setup-client";
import o from "./online.module.css";

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
/** "November 15, 2026" from an ISO date. */
const longDay = (iso: string) =>
  `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${Number(iso.slice(8, 10))}, ${iso.slice(0, 4)}`;

/** The licence in a line: "Subscription · paid until November 15, 2026". */
export function licenceLine(l: KeyLicence): string {
  if (l.licenseType === "perpetual") return "Perpetual licence · never expires";
  if (l.licenseType === "trial") return l.trialEndsAt ? `Trial · until ${longDay(l.trialEndsAt)}` : "Trial";
  return l.paidUntil ? `Subscription · paid until ${longDay(l.paidUntil)}` : "Subscription";
}

/** The ring closes 2.12 s in; the chime's last notes sit 0.3 s into it, so it starts here (spec §1.1). */
const CHIME_AT_MS = 1820;

/**
 * "Congratulations — your LUME is online" (owner, 2026-10-15; canvas Main, KeyObsidian): the mark rises and turns,
 * a green ring draws round it as the online chime lands, then the words and Proceed to onboarding. With reduced
 * motion it's the final frame, and the chime at once.
 */
export function OnlineMoment({
  licence,
  reduce,
  busy,
  onProceed,
}: {
  licence: KeyLicence;
  reduce: boolean;
  busy?: boolean;
  onProceed(): void;
}) {
  const { play } = useSound();
  useEffect(() => {
    const t = setTimeout(() => play("online"), reduce ? 120 : CHIME_AT_MS);
    return () => clearTimeout(t);
  }, [play, reduce]);

  return (
    <div className={o.cel} data-still={reduce || undefined} role="status" aria-live="polite">
      <div className={o.stage} aria-hidden>
        <svg className={o.ring} viewBox="0 0 148 148">
          <circle className={o.track} cx="74" cy="74" r="68" />
          <circle className={o.arc} cx="74" cy="74" r="68" />
        </svg>
        <span className={o.pulse} />
        <div className={o.riser}>
          <img className={o.turner} src="/lume-mark.png" alt="" width={76} height={76} />
        </div>
        <span className={o.badge}>
          <svg viewBox="0 0 24 24">
            <path className={o.tick} d="M5 12.5l4.5 4.5L19 7.5" />
          </svg>
        </span>
      </div>
      <p className={`${o.title} ${o.w1}`}>Congratulations — your LUME is online</p>
      <p className={`${o.sub} ${o.w2}`}>
        Your key is approved and this LUME is yours. <strong>{licenceLine(licence)}.</strong>
      </p>
      <div className={`${o.go} ${o.w3}`}>
        <Button variant="primary" className={o.proceed} loading={busy} onClick={onProceed}>
          Proceed to onboarding
          <svg viewBox="0 0 16 16" aria-hidden className={o.arrow}>
            <path d="M3 8h10M9 4l4 4-4 4" />
          </svg>
        </Button>
      </div>
    </div>
  );
}
