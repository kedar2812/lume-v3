"use client";
import { motion, useReducedMotion } from "motion/react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Avatar } from "@/components/ui/Avatar";
import { SPRINGS, toMotion } from "@/lib/motion";
import { NavIcon } from "./icons";
import { NAV_ITEMS, activeNav, visibleNav } from "./nav";
import { usePageNav } from "./PageTransition";
import s from "./shell.module.css";

type Props = { businessName: string; user: { name: string; role: string }; can: (p: string) => boolean };

export function Sidebar({ businessName, user, can }: Props) {
  const pathname = usePathname();
  const items = visibleNav(NAV_ITEMS, can);
  const current = activeNav(items, pathname);
  const { go } = usePageNav();
  const reduce = useReducedMotion();
  return (
    <aside className={s.side}>
      <div className={s.lockup} data-testid="lockup">
        <img src="/lume-mark.png" alt="" />
        <div>
          <span className={s.brand}>LUME</span>
          <span className={s.client}>{businessName}</span>
        </div>
      </div>
      <nav className={s.nav} aria-label="Main">
        {items.map((i) => {
          const on = i.id === current?.id;
          return (
            <Link
              key={i.id}
              href={i.href}
              className={s.link}
              aria-current={on ? "page" : undefined}
              onClick={(e) => {
                if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
                e.preventDefault();
                go(i.href);
              }}
            >
              {on && (
                // One shared pill travels between items; it stretches slightly along the way (spec §5.3).
                <motion.span
                  layoutId="nav-pill"
                  className={s.pill}
                  transition={reduce ? { duration: 0 } : { layout: toMotion(SPRINGS.default) }}
                />
              )}
              <NavIcon name={i.icon} />
              <span>{i.label}</span>
            </Link>
          );
        })}
      </nav>
      <div className={s.spacer} />
      <div className={s.me}>
        <Avatar name={user.name} color="linear-gradient(135deg,#2A5BFF,#16B5FF)" />
        <div>
          <span className={s.meName}>{user.name}</span>
          <span className={s.meRole}>{user.role}</span>
        </div>
      </div>
    </aside>
  );
}
