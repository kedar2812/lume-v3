import Link from "next/link";
import { GROUP_TITLES, areasFor, type SettingsArea } from "@/lib/settings/areas";
import type { Session } from "@/server/session";
import s from "./settings.module.css";

/** Settings home: the areas this person may open, grouped, each with a line about what's inside. */
export function SettingsHome({ session }: { session: Session }) {
  const areas = areasFor(session.actor);
  const groups = (["workspace", "people", "you"] as const)
    .map((g) => ({ g, items: areas.filter((a) => a.group === g) }))
    .filter((x) => x.items.length > 0);
  return (
    <div className={s.home}>
      {groups.map(({ g, items }) => (
        <section key={g} className={s.group} aria-labelledby={`group-${g}`}>
          <h2 id={`group-${g}`} className={s.groupTitle}>
            {GROUP_TITLES[g]}
          </h2>
          <ul className={s.cards}>
            {items.map((a: SettingsArea) => (
              <li key={a.id}>
                <Link href={a.href} className={s.card}>
                  <span className={s.cardTitle}>{a.title}</span>
                  <span className={s.cardBlurb}>{a.blurb}</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
