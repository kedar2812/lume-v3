import type { ReactNode } from "react";
import { SettingsNav } from "@/components/settings/SettingsNav";
import { SettingsContent } from "@/components/settings/SettingsSearch";
import s from "@/components/settings/settings.module.css";
import { areasFor } from "@/lib/settings/areas";
import { requireSession } from "@/server/session";

/**
 * Every Settings page sits beside the section nav, which lists only what this person may open, with Search on top.
 * The nav scrolls on its own beside the page (owner, 2026-10-05): About is a scroll of the list away, not the page.
 */
export default async function SettingsLayout({ children }: { children: ReactNode }) {
  const session = await requireSession();
  return (
    <div className={s.layout}>
      <SettingsNav areas={areasFor(session.actor)} />
      <SettingsContent>{children}</SettingsContent>
    </div>
  );
}
