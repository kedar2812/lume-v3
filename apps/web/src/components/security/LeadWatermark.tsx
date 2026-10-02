"use client";
import { usePathname } from "next/navigation";
import { Watermark, watermarkText } from "./Watermark";
import s from "./watermark.module.css";

/** Lead screens: the list (and a lead's drawer over it), and the board. */
const LEAD_SCREENS = ["/leads", "/pipeline"];

/**
 * The on-screen watermark over lead screens (6A, spec §2.6), for whoever it applies to: a layer over the main pane,
 * above the lead drawer and below dialogs, that never takes a click.
 */
export function LeadWatermark({
  show,
  viewer,
}: {
  show: boolean;
  viewer: { name: string; email: string; today: string };
}) {
  const path = usePathname();
  if (!show || !LEAD_SCREENS.some((p) => path === p || path.startsWith(`${p}/`))) return null;
  return (
    <div className={s.layer}>
      <Watermark text={watermarkText(viewer)} />
    </div>
  );
}
