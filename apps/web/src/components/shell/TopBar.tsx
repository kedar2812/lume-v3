"use client";
import { Bell, Search } from "lucide-react";
import { usePathname } from "next/navigation";
import { ThemeToggle } from "@/components/theme/ThemeToggle";
import { IconButton } from "@/components/ui/IconButton";
import { Kbd } from "@/components/ui/Kbd";
import type { ThemePref } from "@/lib/theme";
import { NAV_ITEMS, activeNav } from "./nav";
import s from "./shell.module.css";

export function TopBar({ theme, onSearch }: { theme: ThemePref; onSearch(): void }) {
  const title = activeNav(NAV_ITEMS, usePathname())?.label ?? "LUME";
  return (
    <header className={s.bar}>
      <h1 className={s.crumb}>{title}</h1>
      <button type="button" className={s.search} onClick={onSearch} data-tour="search">
        <Search size={15} aria-hidden />
        Search leads, actions…
        <Kbd>Ctrl K</Kbd>
      </button>
      <ThemeToggle initial={theme} />
      <IconButton label="Notifications" data-tour="notifications">
        <Bell size={18} strokeWidth={1.8} aria-hidden />
      </IconButton>
    </header>
  );
}
