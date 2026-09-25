import type { ReactNode } from "react";
import s from "./settings.module.css";

/** The frame of every Settings page: its title, one line about it, actions on the right, then the page. */
export function SettingsPage({
  title,
  description,
  actions,
  children,
}: {
  title: string;
  description: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className={s.page} aria-labelledby="settings-title">
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
