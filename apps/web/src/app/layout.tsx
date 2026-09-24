import type { Metadata } from "next";
import { cookies } from "next/headers";
import type { CSSProperties, ReactNode } from "react";
import { HydrationMark } from "@/components/feedback/HydrationMark";
import { SoundProvider } from "@/components/feedback/SoundProvider";
import { ToastProvider } from "@/components/feedback/ToastProvider";
import { springCssVars } from "@/lib/motion";
import { THEME_COOKIE, parseThemePref } from "@/lib/theme";
import "@/styles/tokens.css";
import "@/styles/base.css";

export const metadata: Metadata = { title: "LUME" };

export default async function RootLayout({ children }: { children: ReactNode }) {
  const theme = parseThemePref((await cookies()).get(THEME_COOKIE)?.value);
  return (
    <html lang="en" data-theme={theme} style={springCssVars() as CSSProperties}>
      <body>
        <SoundProvider>
          <ToastProvider>{children}</ToastProvider>
          <HydrationMark />
        </SoundProvider>
      </body>
    </html>
  );
}
