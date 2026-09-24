import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { AppShell } from "@/components/shell/AppShell";
import { THEME_COOKIE, parseThemePref } from "@/lib/theme";
import { businessName, requireSession } from "@/server/session";

export default async function AppLayout({ children }: { children: ReactNode }) {
  const session = await requireSession();
  // Onboarding — and any outstanding required two-step enrolment — comes before the app itself.
  if (session.flags.needsOnboarding || session.flags.needsTwoFactorEnrolment) redirect("/welcome");
  // The cookie renders without a flash; the stored choice is the fallback on a new device.
  const cookieTheme = parseThemePref((await cookies()).get(THEME_COOKIE)?.value);
  const theme = cookieTheme === "system" ? session.user.theme : cookieTheme;
  return (
    <AppShell session={session} businessName={await businessName()} theme={theme}>
      {children}
    </AppShell>
  );
}
