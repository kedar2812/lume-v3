import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "LUME Licences",
  robots: { index: false, follow: false },
  icons: { icon: "/lume-mark.png" },
};
export const viewport: Viewport = { width: "device-width", initialScale: 1 };

/** The remembered theme is set before the first paint, so dark never flashes light. */
const THEME_BOOT = `try{var t=localStorage.getItem("lume-licence-theme");if(t!=="light"&&t!=="dark")t=matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light";document.documentElement.dataset.theme=t}catch(e){}`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
