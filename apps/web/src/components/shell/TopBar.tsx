"use client";
import { Bell, Search } from "lucide-react";
import { motion, useAnimationControls, useReducedMotion } from "motion/react";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { NotificationCentre } from "@/components/notifications/NotificationCentre";
import { ThemeToggle } from "@/components/theme/ThemeToggle";
import { IconButton } from "@/components/ui/IconButton";
import { Kbd } from "@/components/ui/Kbd";
import { READ_EVENT, notificationsClient } from "@/lib/notifications/client";
import { useStream } from "@/lib/notifications/stream";
import type { ThemePref } from "@/lib/theme";
import { NAV_ITEMS, activeNav } from "./nav";
import s from "./shell.module.css";

export function TopBar({
  theme,
  tz,
  canMessage,
  onSearch,
}: {
  theme: ThemePref;
  tz?: string | null;
  canMessage?: boolean;
  onSearch(): void;
}) {
  const pathname = usePathname();
  const title = activeNav(NAV_ITEMS, pathname)?.label ?? "LUME";
  const reduce = useReducedMotion();
  const swing = useAnimationControls();
  const [unread, setUnread] = useState(0);
  const [open, setOpen] = useState(false);
  const bell = useRef<HTMLButtonElement>(null);

  // The bell knows (Phase 3 spec §6): a dot while anything is unread, lit live and silently, with a small
  // swing when one arrives. Whatever reads them says how many are left (READ_EVENT), and the bell follows.
  useEffect(() => {
    void notificationsClient.list().then((r) => r.ok && setUnread(r.data.unread));
    const read = (e: Event) => setUnread((e as CustomEvent<{ unread?: number }>).detail?.unread ?? 0);
    window.addEventListener(READ_EVENT, read);
    return () => window.removeEventListener(READ_EVENT, read);
  }, []);
  useStream(() => {
    setUnread((n) => n + 1);
    if (!reduce) void swing.start({ rotate: [0, 14, -10, 6, 0], transition: { duration: 0.6 } });
  });

  // "(3) LUME": the window title says how many are unread (frontend spec §8.5) — on every page, since a
  // client-side move sets the page's own title afresh (3B final review, Important 5).
  useEffect(() => {
    const base = document.title.replace(/^\(\d+\) /, "");
    document.title = unread ? `(${unread}) ${base}` : base;
  }, [unread, pathname]);
  const close = () => {
    setOpen(false);
    bell.current?.focus();
    void notificationsClient.list().then((r) => r.ok && setUnread(r.data.unread));
  };
  const now = useRef({ open, close });
  now.current = { open, close };
  // "." opens and closes the centre, unless someone is typing. Closing goes the one way the bell does.
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.key !== "." || e.metaKey || e.ctrlKey || e.altKey) return;
      if (t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable)) return;
      e.preventDefault();
      if (now.current.open) now.current.close();
      else setOpen(true);
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);

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
        ref={bell}
        label={unread ? `Notifications, ${unread} unread` : "Notifications"}
        data-tour="notifications"
        className={s.bell}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => (open ? close() : setOpen(true))}
      >
        <motion.span animate={swing} style={{ display: "grid", transformOrigin: "50% 10%" }}>
          <Bell size={18} strokeWidth={1.8} aria-hidden />
        </motion.span>
        {unread > 0 && <span className={s.bellDot} aria-hidden />}
      </IconButton>
      <NotificationCentre open={open} onClose={close} tz={tz} canMessage={!!canMessage} />
    </header>
  );
}
