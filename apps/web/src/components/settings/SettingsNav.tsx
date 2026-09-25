"use client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import type { SettingsArea } from "@/lib/settings/areas";
import s from "./settings.module.css";

/**
 * The Settings sections beside every Settings page (a select on a narrow screen), with the current one
 * marked. Only the areas this person may open are listed.
 */
export function SettingsNav({ areas }: { areas: SettingsArea[] }) {
  const path = usePathname();
  const router = useRouter();
  const current = areas.find((a) => path === a.href || path.startsWith(`${a.href}/`));
  return (
    <>
      <nav className={s.nav} aria-label="Settings">
        <Link href="/settings" className={s.navLink} aria-current={path === "/settings" ? "page" : undefined}>
          All settings
        </Link>
        {areas.map((a) => (
          <Link
            key={a.id}
            href={a.href}
            className={s.navLink}
            aria-current={current?.id === a.id ? "page" : undefined}
          >
            {a.title}
          </Link>
        ))}
      </nav>
      <label className={s.navSelect}>
        <span className={s.srOnly}>Settings section</span>
        <select value={current?.href ?? "/settings"} onChange={(e) => router.push(e.target.value)}>
          <option value="/settings">All settings</option>
          {areas.map((a) => (
            <option key={a.id} value={a.href}>
              {a.title}
            </option>
          ))}
        </select>
      </label>
    </>
  );
}
