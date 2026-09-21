import type { Metadata } from "next";
import type { ReactNode } from "react";
import "@/styles/tokens.css";
import "@/styles/base.css";

export const metadata: Metadata = { title: "LUME" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" data-theme="system">
      <body>{children}</body>
    </html>
  );
}
