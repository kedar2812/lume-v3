import type { KeyboardEvent } from "react";

const NEXT = new Set(["ArrowRight", "ArrowDown"]);
const PREV = new Set(["ArrowLeft", "ArrowUp"]);

/**
 * Keyboard paths for a group of tabs or radio buttons (Phase 9 Task 6; WAI-ARIA tabs and radio group): the group
 * is one Tab stop (the chosen option carries tabIndex 0, the rest -1), and the arrow keys, Home and End move
 * between its options and choose the one reached, wrapping at the ends. Put it on the group's onKeyDown.
 */
export function roving(e: KeyboardEvent<HTMLElement>, role: "tab" | "radio"): void {
  if (!NEXT.has(e.key) && !PREV.has(e.key) && e.key !== "Home" && e.key !== "End") return;
  const items = [
    ...e.currentTarget.querySelectorAll<HTMLElement>(
      `[role="${role}"]:not([disabled]):not([aria-disabled="true"])`,
    ),
  ];
  const at = items.indexOf(document.activeElement as HTMLElement);
  if (at < 0 || !items.length) return;
  e.preventDefault();
  const to =
    e.key === "Home"
      ? 0
      : e.key === "End"
        ? items.length - 1
        : (at + (NEXT.has(e.key) ? 1 : -1) + items.length) % items.length;
  items[to]!.focus();
  items[to]!.click();
}
