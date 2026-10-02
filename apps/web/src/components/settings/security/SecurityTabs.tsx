"use client";
import { motion, useReducedMotion } from "motion/react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { SPRINGS, toMotion } from "@/lib/motion";
import s from "./security.module.css";

export type SecurityTab = { href: string; label: string };

/** Security's sections as links (each is its own page, so Back and deep links work), the current one underlined. */
export function SecurityTabs({ tabs }: { tabs: SecurityTab[] }) {
  const path = usePathname();
  const reduce = useReducedMotion();
  // The longest matching href wins: /settings/security/rules is Rules, not Overview.
  const current = [...tabs]
    .sort((a, b) => b.href.length - a.href.length)
    .find((t) => path.startsWith(t.href));
  return (
    <nav className={s.tabs} aria-label="Security">
      {tabs.map((t) => {
        const on = t.href === current?.href;
        return (
          <Link key={t.href} href={t.href} className={s.tab} aria-current={on ? "page" : undefined}>
            {t.label}
            {on && (
              <motion.span
                layoutId="security-tab"
                className={s.underline}
                transition={reduce ? { duration: 0 } : toMotion(SPRINGS.default)}
              />
            )}
          </Link>
        );
      })}
    </nav>
  );
}
