/**
 * Browsers turn the mouse wheel into +1 / −1 on a focused number field — so scrolling a Settings page past one
 * quietly changes a follow-up's days or a queue's size. A wheel over the focused number field lets go of it
 * instead: the page scrolls and the value stays as typed. Returns the undo.
 */
export function guardNumberWheel(doc: Document): () => void {
  const onWheel = (e: WheelEvent) => {
    const t = e.target;
    if (t instanceof HTMLInputElement && t.type === "number" && doc.activeElement === t) t.blur();
  };
  doc.addEventListener("wheel", onWheel, { passive: true, capture: true });
  return () => doc.removeEventListener("wheel", onWheel, { capture: true });
}
