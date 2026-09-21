import { cookies } from "next/headers";
import type { ReactNode } from "react";
import { AppShell } from "@/components/shell/AppShell";
import { THEME_COOKIE, parseThemePref } from "@/lib/theme";

// Phase 1 replaces these with the signed-in user's session, settings.business_name and effective permissions.
const DEV_PERMISSIONS = ["leads.view", "calendar.view", "templates.use", "analytics.view", "settings.manage"];

export default async function AppLayout({ children }: { children: ReactNode }) {
  const theme = parseThemePref((await cookies()).get(THEME_COOKIE)?.value);
  return (
    <AppShell
      businessName="Nupuur Coaching"
      user={{ name: "Tasneem", role: "Admin" }}
      permissions={DEV_PERMISSIONS}
      theme={theme}
    >
      {children}
    </AppShell>
  );
}
