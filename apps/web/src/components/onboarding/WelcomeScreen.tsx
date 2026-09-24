"use client";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { shellIdentity } from "@/components/shell/AppShell";
import { PageTransitionProvider } from "@/components/shell/PageTransition";
import { Sidebar } from "@/components/shell/Sidebar";
import { onboardingActions } from "@/lib/onboarding-client";
import { tourClient } from "@/lib/tour-client";
import type { Session } from "@/server/session";
import { Onboarding } from "./Onboarding";
import s from "./onboarding.module.css";

const LEAVE_MS = 700; // long enough for the sheet to dissolve and the app to come into focus

/**
 * The glass sheet over the person's own app: their real sidebar and a quiet Today, blurred and inert
 * (nothing behind can be focused or clicked). On finishing, the sheet dissolves and the blur lifts
 * before the real Today takes over.
 */
export function WelcomeScreen({ session, businessName }: { session: Session; businessName: string }) {
  const router = useRouter();
  const actions = useMemo(() => onboardingActions(), []);
  const [leaving, setLeaving] = useState(false);
  const { can, user } = shellIdentity(session);
  const first = session.user.name.split(" ")[0];

  return (
    <div className={s.stage} data-leaving={leaving || undefined}>
      <div className={s.backdrop} inert aria-hidden>
        <PageTransitionProvider>
          <div className={s.fakeApp}>
            <Sidebar businessName={businessName} user={user} can={can} />
            <div className={s.fakeMain}>
              <div className={s.fakePage}>
                <h2>Good to see you, {first}</h2>
                <p>Today</p>
                <div className={s.fakeKpis}>
                  <span />
                  <span />
                  <span />
                  <span />
                </div>
                <div className={s.fakeRows}>
                  <span />
                  <span />
                  <span />
                  <span />
                </div>
              </div>
            </div>
          </div>
        </PageTransitionProvider>
      </div>
      <div className={s.scrim} />
      <div className={s.aura} aria-hidden>
        <i />
        <i />
      </div>
      <Onboarding
        session={session}
        businessName={businessName}
        actions={actions}
        onFinished={({ startTour }) => {
          // "Explore on my own" is an answer: the tour must not then start by itself on Today.
          if (!startTour) void tourClient.skip().catch(() => undefined);
          setLeaving(true);
          setTimeout(() => {
            router.replace(startTour ? "/today?tour=1" : "/today");
            router.refresh(); // the layout reads the session again, now without the onboarding flag
          }, LEAVE_MS);
        }}
      />
    </div>
  );
}
