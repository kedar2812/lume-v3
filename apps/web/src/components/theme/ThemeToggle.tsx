"use client";
import { useState } from "react";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { themeCookie, type ThemePref } from "@/lib/theme";

const OPTIONS = [
  { value: "system", label: "Auto" },
  { value: "porcelain", label: "Porcelain" },
  { value: "obsidian", label: "Obsidian" },
] as const;

export function ThemeToggle({ initial }: { initial: ThemePref }) {
  const [pref, setPref] = useState<ThemePref>(initial);
  return (
    <SegmentedControl
      label="Theme"
      value={pref}
      options={OPTIONS}
      onChange={(v) => {
        setPref(v);
        document.documentElement.dataset.theme = v;
        document.cookie = themeCookie(v);
      }}
    />
  );
}
