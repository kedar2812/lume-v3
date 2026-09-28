"use client";
import { Bell, Search } from "lucide-react";
import { motion, useAnimationControls, useReducedMotion } from "motion/react";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ThemeToggle } from "@/components/theme/ThemeToggle";
import { IconButton } from "@/components/ui/IconButton";
import { Kbd } from "@/components/ui/Kbd";
import { READ_EVENT, notificationsClient } from "@/lib/notifications/client";
import { useStream } from "@/lib/notifications/stream";
import type { ThemePref } from "@/lib/theme";
import { NAV_ITEMS, activeNav } from "./nav";
import s from "./shell.module.css";

export function TopBar({ theme, onSearch }: { theme: ThemePref; onSearch(): void }) {
  const title = activeNav(NAV_ITEMS, usePathname())?.label ?? "LUME";
  const router = useRouter();
  const reduce = useReducedMotion();
  const swing = useAnimationControls();
  const [unread, setUnread] = useState(false);

  // The bell knows (Phase 3 spec §6): a dot while anything is unread, lit live and silently, with a small
  // swing when one arrives. Reading them (Today, until 3B's centre) lets it go.
  useEffect(() => {
    void notificationsClient.list().then((r) => r.ok && setUnread(r.data.unread > 0));
    const read = () => setUnread(false);
    window.addEventListener(READ_EVENT, read);
    return () => window.removeEventListener(READ_EVENT, read);
  }, []);
  useStream(() => {
    setUnread(true);
    if (!reduce) void swing.start({ rotate: [0, 14, -10, 6, 0], transition: { duration: 0.6 } });
  });

  return (
    <header className={s.bar}>
      <h1 className={s.crumb}>{title}</h1>
      <button type="button" className={s.search} onClick={onSearch} data-tour="search">
        <Search size={15} aria-hidden />
        Search leads, actions…
        <Kbd>Ctrl K</Kbd>
      </button>
      <ThemeToggle initial={theme} />
      <IconButton
        label={unread ? "Notifications, new ones waiting" : "Notifications"}
        data-tour="notifications"
        className={s.bell}
        onClick={() => router.push("/today")}
      >
        <motion.span animate={swing} style={{ display: "grid", transformOrigin: "50% 10%" }}>
          <Bell size={18} strokeWidth={1.8} aria-hidden />
        </motion.span>
        {unread && <span className={s.bellDot} aria-hidden />}
      </IconButton>
    </header>
  );
}
