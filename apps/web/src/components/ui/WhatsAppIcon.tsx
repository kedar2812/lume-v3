import s from "./WhatsAppIcon.module.css";

/**
 * WhatsApp, as its iOS app icon (owner, 2026-10-19): WhatsApp's own App Store artwork, unmodified, under iOS's rounded
 * mask (public/brand/README.md). Everywhere LUME shows WhatsApp, this one icon. `ring` keeps it apart from a
 * WhatsApp-green surface (the green send button). Decorative unless `label` names it.
 */
export function WhatsAppIcon({
  size = 20,
  ring = false,
  label,
  className,
}: {
  size?: number;
  ring?: boolean;
  label?: string;
  className?: string;
}) {
  return (
    <img
      className={[s.icon, ring ? s.ring : "", className ?? ""].filter(Boolean).join(" ")}
      src="/brand/whatsapp-app.png"
      alt={label ?? ""}
      aria-hidden={label ? undefined : true}
      width={size}
      height={size}
      draggable={false}
      decoding="async"
    />
  );
}
