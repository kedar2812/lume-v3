import type { ReactNode } from "react";
import { SettingsNav } from "@/components/settings/SettingsNav";
import s from "@/components/settings/settings.module.css";
import { areasFor } from "@/lib/settings/areas";
import { requireSession } from "@/server/session";

/** Every Settings page sits beside the section nav, which lists only what this person may open. */
export default async function SettingsLayout({ children }: { children: ReactNode }) {
  const session = await requireSession();
  return (
    <div className={s.layout}>
      <SettingsNav areas={areasFor(session.actor)} />
      <div>{children}</div>
    </div>
  );
}
