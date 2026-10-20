"use client";
import { useIsPresent } from "motion/react";
import { createContext, useContext, type ReactNode } from "react";
import { createPortal } from "react-dom";

/** Where a view puts its own controls: the viewer's header, beside the file's name. */
export const ToolbarSlot = createContext<HTMLElement | null>(null);

/**
 * A view's controls (a photo's zoom, a PDF's pages), drawn in the viewer's header: only the file being shown's, never
 * the one leaving as the next comes in.
 */
export function Toolbar({ children }: { children: ReactNode }) {
  const slot = useContext(ToolbarSlot);
  const present = useIsPresent();
  return slot && present ? createPortal(children, slot) : null;
}
