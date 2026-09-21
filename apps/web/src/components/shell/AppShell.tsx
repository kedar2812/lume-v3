"use client";
import { useEffect, useState, type ReactNode } from "react";
import type { ThemePref } from "@/lib/theme";
import { CommandPalette } from "./CommandPalette";
import { PageContent, PageTransitionProvider } from "./PageTransition";
import { Sidebar } from "./Sidebar";
import { TopBar } from "./TopBar";
import s from "./shell.module.css";

type Props = {
  businessName: string;
  user: { name: string; role: string };
  permissions: string[];
  theme: ThemePref;
  children: ReactNode;
};

export function AppShell({ businessName, user, permissions, theme, children }: Props) {
  const [palette, setPalette] = useState(false);
  const can = (p: string) => permissions.includes(p);

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
    </PageTransitionProvider>
  );
}
