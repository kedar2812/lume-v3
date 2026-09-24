"use client";
import { useEffect } from "react";

/**
 * Marks <html data-hydrated> once React has taken over the server-rendered page, i.e. once clicks and
 * shortcuts actually do something. Invisible; the end-to-end tests wait for it instead of racing.
 */
export function HydrationMark() {
  useEffect(() => {
    document.documentElement.dataset.hydrated = "true";
  }, []);
  return null;
}
