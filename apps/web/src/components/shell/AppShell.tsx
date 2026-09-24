"use client";
import { useEffect, useState, type ReactNode } from "react";
import { can as canCore, isPermissionKey } from "@lume/core/shared";
import type { ThemePref } from "@/lib/theme";
import type { Session } from "@/server/session";
import { TourProvider } from "@/components/tour/TourProvider";
import { tourClient } from "@/lib/tour-client";
import { CommandPalette } from "./CommandPalette";
import { PageContent, PageTransitionProvider } from "./PageTransition";
import { Sidebar } from "./Sidebar";
import { TopBar } from "./TopBar";
import s from "./shell.module.css";

type Props = { session: Session; businessName: string; theme: ThemePref; children: ReactNode };

/** What to call someone in the sidebar: the owner, an admin (manages people), or their role's work. */
function roleLabel(session: Session): string {
  if (session.user.isOwner) return "Owner";
  return canCore(session.actor, "users.manage") ? "Admin" : "Sales";
}

/**
 * The sidebar's inputs for a session. The permission check is the very same one the API runs, imported
 * from @lume/core, never a second implementation. Shared with the onboarding backdrop.
 */
export function shellIdentity(session: Session) {
  return {
    can: (p: string) => isPermissionKey(p) && canCore(session.actor, p),
    user: { name: session.user.name, role: roleLabel(session) },
  };
}

export function AppShell({ session, businessName, theme, children }: Props) {
  const [palette, setPalette] = useState(false);
  const { can, user } = shellIdentity(session);

  useEffect(() => {
    // Scrollbars fade in while scrolling (spec §4.4).
    const timers = new WeakMap<Element, ReturnType<typeof setTimeout>>();
    const onScroll = (e: Event) => {
      const el = e.target instanceof Element ? e.target : document.documentElement;
      el.classList.add("is-scrolling");
      clearTimeout(timers.get(el));
      timers.set(
        el,
        setTimeout(() => el.classList.remove("is-scrolling"), 900),
      );
    };
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPalette((v) => !v);
      }
    };
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  return (
    <PageTransitionProvider>
      <TourProvider session={session} client={tourClient} autoStart>
        <div className={s.app}>
          <Sidebar businessName={businessName} user={user} can={can} />
          <main className={s.main}>
            <TopBar theme={theme} onSearch={() => setPalette(true)} />
            <div className={s.scroll} data-scroll>
              <div className={s.page}>
                <PageContent>{children}</PageContent>
              </div>
            </div>
          </main>
        </div>
        <CommandPalette open={palette} onOpenChange={setPalette} can={can} />
      </TourProvider>
    </PageTransitionProvider>
  );
}
