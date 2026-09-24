"use client";
import { useEffect, useId, useRef, useState } from "react";
import { useTour } from "@/components/tour/TourProvider";
import { Avatar } from "@/components/ui/Avatar";
import { api } from "@/lib/api";
import s from "./shell.module.css";

/** The person's row at the foot of the sidebar, opening a small menu: replay the tour, or sign out. */
export function ProfileMenu({ user }: { user: { name: string; role: string } }) {
  const [open, setOpen] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const menuId = useId();
  const root = useRef<HTMLDivElement>(null);
  const tour = useTour();

  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => !root.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", esc);
    root.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  async function signOut() {
    setLeaving(true);
    await api.post("/api/v1/auth/logout");
    // A full load: nothing from this session stays in memory.
    window.location.assign("/sign-in");
  }

  return (
    <div className={s.meWrap} ref={root}>
      {open && (
        <div className={s.meMenu} role="menu" id={menuId} aria-label="Your account">
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              tour.start();
            }}
          >
            Replay the tour
          </button>
          <button type="button" role="menuitem" onClick={() => void signOut()} disabled={leaving}>
            {leaving ? "Signing out…" : "Sign out"}
          </button>
        </div>
      )}
      <button
        type="button"
        className={s.me}
        data-tour="profile"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((v) => !v)}
      >
        <Avatar name={user.name} color="linear-gradient(135deg,#2A5BFF,#16B5FF)" />
        <span>
          <span className={s.meName}>{user.name}</span>
          <span className={s.meRole}>{user.role}</span>
        </span>
      </button>
    </div>
  );
}
