"use client";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import s from "./settings.module.css";

/** A same-tab link inside LUME that a plain click would follow: the one place in-app navigation can be asked about. */
function linkLeaving(e: MouseEvent): string | null {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return null;
  const a = (e.target as Element | null)?.closest?.("a[href]");
  if (!(a instanceof HTMLAnchorElement) || (a.target && a.target !== "_self") || a.hasAttribute("download"))
    return null;
  const to = new URL(a.href, window.location.href);
  if (to.origin !== window.location.origin) return null;
  const here = window.location;
  // The same page (a #section) isn't leaving.
  if (to.pathname === here.pathname && to.search === here.search) return null;
  return `${to.pathname}${to.search}${to.hash}`;
}

/**
 * Owner ruling 2026-10-18 (1): while a Settings form has unsaved changes, a link inside LUME asks "Leave without saving?"
 * first, and closing or reloading the tab asks the browser's way. Returns the sheet to render.
 */
export function useLeaveGuard(dirty: boolean): ReactNode {
  const router = useRouter();
  const [to, setTo] = useState<string | null>(null);
  const live = useRef(dirty);
  live.current = dirty;

  useEffect(() => {
    if (!dirty) return;
    const click = (e: MouseEvent) => {
      const where = linkLeaving(e);
      if (!where || !live.current) return;
      // Before the link (and Next's own handler) sees it.
      e.preventDefault();
      e.stopPropagation();
      setTo(where);
    };
    const unload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      // Older browsers ask only when this is set.
      e.returnValue = "";
    };
    document.addEventListener("click", click, true);
    window.addEventListener("beforeunload", unload);
    return () => {
      document.removeEventListener("click", click, true);
      window.removeEventListener("beforeunload", unload);
    };
  }, [dirty]);

  if (!to) return null;
  return (
    <Dialog label="Leave without saving?" onClose={() => setTo(null)}>
      <h2 className={s.leaveTitle}>Leave without saving?</h2>
      <p className={s.leaveLede}>Your changes on this page haven&apos;t been saved.</p>
      <div className={s.leaveActions}>
        <Button variant="ghost" onClick={() => setTo(null)}>
          Keep editing
        </Button>
        <Button
          variant="danger"
          onClick={() => {
            live.current = false;
            setTo(null);
            router.push(to);
          }}
        >
          Leave without saving
        </Button>
      </div>
    </Dialog>
  );
}
