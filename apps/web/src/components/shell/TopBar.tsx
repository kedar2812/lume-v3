"use client";
import { Bell, Search } from "lucide-react";
import { motion, useAnimationControls, useReducedMotion } from "motion/react";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useToast } from "@/components/feedback/ToastProvider";
import { NotificationCentre } from "@/components/notifications/NotificationCentre";
import { ResumeRun } from "@/components/queue/ResumeRun";
import { ThemeToggle } from "@/components/theme/ThemeToggle";
import { IconButton } from "@/components/ui/IconButton";
import { Kbd } from "@/components/ui/Kbd";
import { TopProgress } from "@/components/ui/TopProgress";
import { OPEN_NOTIFICATIONS, READ_EVENT, notificationsClient } from "@/lib/notifications/client";
import { useStream } from "@/lib/notifications/stream";
import type { ThemePref } from "@/lib/theme";
import { NAV_ITEMS, activeNav } from "./nav";
import s from "./shell.module.css";

/** How often the bell rings again while something is unread. */
const RING_EVERY_MS = 30_000;

export function TopBar({
  theme,
  tz,
  canMessage,
  canQueue,
  onSearch,
  mac = false,
}: {
  theme: ThemePref;
  tz?: string | null;
  canMessage?: boolean;
  /** A send queue left open is picked up again from here (4C). */
  canQueue?: boolean;
  onSearch(): void;
  /** The search shortcut as this computer spells it: ⌘K on a Mac, Ctrl K elsewhere. */
  mac?: boolean;
}) {
  const { toast } = useToast();
  const router = useRouter();
  const pathname = usePathname();
  const title = activeNav(NAV_ITEMS, pathname)?.label ?? "LUME";
  const reduce = useReducedMotion();
  const swing = useAnimationControls();
  const [unread, setUnread] = useState(0);
  /** What arrived last, said politely to screen readers (the swing and the dot say it to eyes). */
  const [arrival, setArrival] = useState("");
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
  useStream((n) => {
    setUnread((c) => c + 1);
    // A Calendly booking (5D) is news worth a notice, with Calendly's own mark; the rest, the bell says.
    const note = n as
      { kind?: string; title?: string; body?: string | null; leadId?: string | null } | undefined;
    if (note?.kind === "meeting_booked" && note.title)
      toast({
        title: note.title,
        ...(note.body ? { detail: note.body } : {}),
        mark: { src: "/brand/calendly.svg", alt: "Calendly" },
        durationMs: 6500,
        ...(note.leadId
          ? { action: { label: "Open", onClick: () => router.push(`/leads?lead=${note.leadId}`) } }
          : {}),
      });
    const title = (n as { title?: string } | undefined)?.title;
    if (title) setArrival(`New notification: ${title}`);
    if (!reduce) void swing.start({ rotate: [0, 14, -10, 6, 0], transition: { duration: 0.6 } });
  });

  // Unread waiting (owner, 2026-10-05): the bell rings, a short damped swing, when the page opens and then every
  // 30 s while the tab is in view, until the centre is opened or nothing is unread. Silent (sound policy). Reduce
  // Motion: no swing; the dot breathes instead (CSS).
  useEffect(() => {
    if (!unread || open || reduce) return;
    const ring = () => {
      if (document.visibilityState === "hidden") return;
      void swing.start({
        rotate: [0, 16, -14, 11, -8, 5, -2, 0],
        transition: { duration: 0.9, ease: "easeOut" },
      });
    };
    const first = setTimeout(ring, 900);
    const again = setInterval(ring, RING_EVERY_MS);
    return () => {
      clearTimeout(first);
      clearInterval(again);
    };
  }, [unread, open, reduce, swing]);

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
    // Search's "Open notifications" action.
    const fromSearch = () => setOpen(true);
    window.addEventListener(OPEN_NOTIFICATIONS, fromSearch);
    return () => {
      window.removeEventListener("keydown", key);
      window.removeEventListener(OPEN_NOTIFICATIONS, fromSearch);
    };
  }, []);

  return (
    <header className={s.bar}>
      <TopProgress />
      <h1 className={s.crumb}>{title}</h1>
      <button type="button" className={s.search} onClick={onSearch} data-tour="search">
        <Search size={15} aria-hidden />
        <span className={s.searchWords}>Search leads, actions…</span>
        <Kbd>{mac ? "⌘K" : "Ctrl K"}</Kbd>
      </button>
      {canQueue && <ResumeRun variant="pill" />}
      {/* 7C: a bulk run tucked away shows here as a pill until it's opened again. */}
      <span id="lume-topbar-slot" className={s.slot} />
      {/* On a phone the theme lives in Settings → My account only: the bar keeps search and the bell. */}
      <span className={s.themeSlot}>
        <ThemeToggle initial={theme} />
      </span>
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
        {unread > 0 && (
          <span className={s.bellDot} aria-hidden data-live-count data-waiting={!open || undefined} />
        )}
      </IconButton>
      <NotificationCentre open={open} onClose={close} tz={tz} canMessage={!!canMessage} />
      <p aria-live="polite" aria-atomic="true" className={s.srOnly}>
        {arrival}
      </p>
    </header>
  );
}
