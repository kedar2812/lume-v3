"use client";
import { useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";

const never = () => () => {};

/**
 * Renders a popup on <body> (7C): no transformed or clipped parent (a page transition, a scroller) can crop it, and
 * it stacks above the sidebar and the top bar. A popup opened in the browser is there on its first render, so its
 * focus and refs work as if it were inline; one in the server's page appears as soon as the page is live.
 */
export function BodyPortal({ children }: { children: ReactNode }) {
  const live = useSyncExternalStore(
    never,
    () => true,
    () => false,
  );
  return live ? createPortal(children, document.body) : null;
}
