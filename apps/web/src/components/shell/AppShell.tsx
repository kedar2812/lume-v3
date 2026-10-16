"use client";
import { lookOf } from "@/lib/avatar/look";
import { LoadingProvider } from "@/lib/loading";
import { AnnouncementStrip } from "@/components/licence/AnnouncementStrip";
import { LicenceBanner } from "@/components/licence/LicenceBanner";
import { LicenceProvider } from "@/components/licence/LicenceProvider";
import { PendingSent } from "@/components/messages/PendingSent";
import { FeedbackSheet } from "@/components/send-feedback/FeedbackSheet";
import { LockScreen } from "@/components/licence/LockScreen";
import { PaymentReminder } from "@/components/licence/PaymentReminder";
import { useEffect, useState, type ReactNode } from "react";
import { can as canCore, isPermissionKey } from "@lume/core/shared";
import type { ThemePref } from "@/lib/theme";
import type { Session } from "@/server/session";
import { TourProvider } from "@/components/tour/TourProvider";
import { tourClient } from "@/lib/tour-client";
import { CommandPalette } from "./CommandPalette";
import { AlertHud } from "@/components/security/AlertHud";
import { LeadWatermark } from "@/components/security/LeadWatermark";
import { PageContent, PageTransitionProvider } from "./PageTransition";
import { MobileTabs } from "./MobileTabs";
import { Sidebar } from "./Sidebar";
import { TopBar } from "./TopBar";
import s from "./shell.module.css";
import { zoneOf } from "@/lib/zone";
import { guardNumberWheel } from "@/lib/ui/wheel";

type Props = {
  session: Session;
  businessName: string;
  theme: ThemePref;
  /** A Mac (from the request): the search shortcut reads ⌘K. */
  mac?: boolean;
  children: ReactNode;
};

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
    user: {
      name: session.user.name,
      role: roleLabel(session),
      ...lookOf(session.user.id, session.user.avatar),
    },
  };
}

export function AppShell({ session, businessName, theme, mac = false, children }: Props) {
  const [palette, setPalette] = useState(false);
  const [feedback, setFeedback] = useState(false);
  const { can, user } = shellIdentity(session);
  // Send feedback (spec 2026-10-16 §1.1): wherever there is a product key to send it under.
  const openFeedback = session.licence.feedback ? () => setFeedback(true) : undefined;

  // A wheel over a focused number field scrolls the page, never changes the value.
  useEffect(() => guardNumberWheel(document), []);

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
    // The shortcuts are live from here on. End-to-end tests wait for this rather than racing hydration.
    document.documentElement.dataset.shell = "ready";
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("keydown", onKey);
      delete document.documentElement.dataset.shell;
    };
  }, []);

  return (
    <PageTransitionProvider>
      <TourProvider session={session} client={tourClient} autoStart>
        <LicenceProvider session={session}>
          <LoadingProvider>
            <div className={s.app}>
              <Sidebar businessName={businessName} user={user} can={can} onFeedback={openFeedback} />
              <MobileTabs can={can} onFeedback={openFeedback} />
              <main className={s.main}>
                {/* The licence (L-A): grace or read-only across the top; paused covers the whole page. */}
                <LicenceBanner />
                <TopBar
                  theme={theme}
                  tz={zoneOf(session.user)}
                  canMessage={canCore(session.actor, "messages.send")}
                  canQueue={canCore(session.actor, "messages.send_queue")}
                  onSearch={() => setPalette(true)}
                  mac={mac}
                />
                {/* From LUME's team (spec 2026-10-16 fleet §4): one at a time, under the top bar. */}
                <AnnouncementStrip zone={zoneOf(session.user)} />
                <div className={s.scroll} data-scroll>
                  <div className={s.page}>
                    <PageContent>{children}</PageContent>
                  </div>
                </div>
                <LockScreen />
                {/* The on-screen watermark over lead screens, for whoever it applies to (6A). */}
                <LeadWatermark
                  show={session.watermark}
                  viewer={{ name: session.user.name, email: session.user.email, today: session.today }}
                />
              </main>
            </div>
            <PaymentReminder businessName={businessName} />
            <PendingSent />
            {/* A security alert, live, for whoever reviews them (6A). */}
            {can("security.manage") && <AlertHud />}
            <CommandPalette open={palette} onOpenChange={setPalette} can={can} onFeedback={openFeedback} />
            {/* Mounted only while open: every opening is a fresh sheet, from the page it was opened on. */}
            {feedback && <FeedbackSheet open onClose={() => setFeedback(false)} />}
          </LoadingProvider>
        </LicenceProvider>
      </TourProvider>
    </PageTransitionProvider>
  );
}
