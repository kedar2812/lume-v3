import Link from "next/link";
import type { ReactNode } from "react";
import s from "./settings.module.css";

type Up = { href: string; label: string };
const ALL: Up = { href: "/settings", label: "All settings" };

/**
 * The frame of every Settings page: the way back (to All settings, or to the section a page sits in), its title,
 * one line about it, actions on the right, then the page. `up={null}` on the home, or a page with its own way back.
 */
export function SettingsPage({
  title,
  description,
  actions,
  up = ALL,
  children,
}: {
  title: string;
  description: string;
  actions?: ReactNode;
  up?: Up | null;
  children: ReactNode;
}) {
  return (
    <section className={s.page} aria-labelledby="settings-title">
      {up && (
        <Link href={up.href} className={s.up} aria-label={`Back to ${up.label}`}>
          <span aria-hidden>‹</span> {up.label}
        </Link>
      )}
      <header className={s.pageHead}>
        <div>
          <h1 id="settings-title" className={s.pageTitle}>
            {title}
          </h1>
          <p className={s.pageLede}>{description}</p>
        </div>
        {actions && <div className={s.pageActions}>{actions}</div>}
      </header>
      {children}
    </section>
  );
}
