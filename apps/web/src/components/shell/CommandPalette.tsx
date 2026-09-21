"use client";
import { AnimatePresence, motion } from "motion/react";
import { Dialog } from "radix-ui";
import { useId, useMemo, useState, type KeyboardEvent } from "react";
import { SPRINGS, toMotion } from "@/lib/motion";
import { NavIcon } from "./icons";
import { NAV_ITEMS, visibleNav } from "./nav";
import { usePageNav } from "./PageTransition";
import s from "./palette.module.css";

type Props = { open: boolean; onOpenChange(v: boolean): void; can(p: string): boolean };

export function CommandPalette({ open, onOpenChange, can }: Props) {
  const [query, setQuery] = useState("");
  const [sel, setSel] = useState(0);
  const { go } = usePageNav();
  const listId = useId();
  const commands = useMemo(
    () =>
      visibleNav(NAV_ITEMS, can).map((i) => ({
        id: i.id,
        label: `Go to ${i.label}`,
        href: i.href,
        icon: i.icon,
      })),
    [can],
  );
  const matches = commands.filter((c) => c.label.toLowerCase().includes(query.trim().toLowerCase()));

  function run(i: number) {
    const c = matches[i];
    if (!c) return;
    onOpenChange(false);
    setQuery("");
    setSel(0);
    go(c.href);
  }
  function onKey(e: KeyboardEvent) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const n = matches.length || 1;
      setSel((v) => (v + (e.key === "ArrowDown" ? 1 : -1) + n) % n);
    } else if (e.key === "Enter") {
      e.preventDefault();
      run(sel);
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <AnimatePresence>
        {open && (
          <Dialog.Portal forceMount>
            <Dialog.Overlay asChild forceMount>
              <motion.div
                className={s.overlay}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
              />
            </Dialog.Overlay>
            <Dialog.Content asChild forceMount aria-describedby={undefined} onKeyDown={onKey}>
              <motion.div
                className={s.panel}
                initial={{ opacity: 0, scale: 0.96, y: -6, filter: "blur(6px)", x: "-50%" }}
                animate={{ opacity: 1, scale: 1, y: 0, filter: "blur(0px)", x: "-50%" }}
                exit={{ opacity: 0, scale: 0.97, y: -4, x: "-50%", transition: { duration: 0.15 } }}
                transition={toMotion(SPRINGS.default)}
              >
                <Dialog.Title
                  style={{
                    position: "absolute",
                    width: 1,
                    height: 1,
                    overflow: "hidden",
                    clip: "rect(0 0 0 0)",
                  }}
                >
                  Command palette
                </Dialog.Title>
                <input
                  className={s.input}
                  role="combobox"
                  aria-label="Search leads or type a command"
                  aria-expanded
                  aria-controls={listId}
                  aria-activedescendant={matches[sel] ? `${listId}-${matches[sel]!.id}` : undefined}
                  placeholder="Search leads, or type a command…"
                  value={query}
                  autoFocus
                  onChange={(e) => {
                    setQuery(e.target.value);
                    setSel(0);
                  }}
                />
                <div className={s.list} role="listbox" id={listId}>
                  <div className={s.group}>Go to</div>
                  {matches.length === 0 && (
                    <div className={s.empty}>No matches. Lead search arrives in Phase 1.</div>
                  )}
                  {matches.map((c, i) => (
                    <div
                      key={c.id}
                      id={`${listId}-${c.id}`}
                      role="option"
                      aria-selected={i === sel}
                      className={s.option}
                      onMouseEnter={() => setSel(i)}
                      onClick={() => run(i)}
                    >
                      <NavIcon name={c.icon} />
                      {c.label}
                    </div>
                  ))}
                </div>
                <div className={s.foot}>
                  <span>↑↓ navigate</span>
                  <span>↵ open</span>
                  <span>esc close</span>
                </div>
              </motion.div>
            </Dialog.Content>
          </Dialog.Portal>
        )}
      </AnimatePresence>
    </Dialog.Root>
  );
}
