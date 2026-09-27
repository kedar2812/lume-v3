import Link from "next/link";
import s from "./integrations.module.css";

/** Spec §5.4: admins hear which sheet needs them, where they already are (Leads, Settings). No bell yet. */
export function AttentionBanner({ items }: { items: { id: string; name: string }[] }) {
  if (!items.length) return null;
  const one = items.length === 1 ? items[0]! : null;
  return (
    <div role="status" className={s.banner}>
      <span className={s.bannerDot} aria-hidden />
      <span>{one ? `“${one.name}” needs attention` : `${items.length} sheets need attention`}</span>
      <Link
        href={one ? `/settings/integrations/${one.id}` : "/settings/integrations"}
        className={s.bannerLink}
      >
        Take a look
      </Link>
    </div>
  );
}
