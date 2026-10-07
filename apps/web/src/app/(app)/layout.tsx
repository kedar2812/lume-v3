import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { AppShell } from "@/components/shell/AppShell";
import { firstRunStop, isLocked } from "@/lib/first-run";
import { THEME_COOKIE, parseThemePref } from "@/lib/theme";
import { ZoneProvider } from "@/components/ZoneProvider";
import { zoneOf } from "@/lib/zone";
import { businessName, requireSession } from "@/server/session";

export default async function AppLayout({ children }: { children: ReactNode }) {
  const session = await requireSession();
  // The agreement, then onboarding (and any required two-step enrolment), come before the app itself.
  const stop = firstRunStop(session.flags, isLocked(session));
  if (stop) redirect(stop);
  // The cookie renders without a flash; the stored choice is the fallback on a new device.
  const cookieTheme = parseThemePref((await cookies()).get(THEME_COOKIE)?.value);
  const theme = cookieTheme === "system" ? session.user.theme : cookieTheme;
  return (
    <ZoneProvider zone={zoneOf(session.user)}>
      <AppShell
        session={session}
        businessName={await businessName()}
        theme={theme}
        // ⌘ on a Mac, Ctrl elsewhere: read from the request, so the hint is right on first paint.
        mac={/Mac|iPhone|iPad/.test((await headers()).get("user-agent") ?? "")}
      >
        {children}
      </AppShell>
    </ZoneProvider>
  );
}
