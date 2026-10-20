/**
 * Keep a drag's pointer on this element even when it leaves it. A pointer the browser no longer counts as active (it
 * lifted between the events, or the event came from a script) can't be captured: that's no reason to stop the page,
 * so it's left alone. Returns whether it was captured.
 */
export function capturePointer(el: Element, pointerId: number): boolean {
  try {
    el.setPointerCapture?.(pointerId);
    return typeof el.setPointerCapture === "function";
  } catch {
    return false;
  }
}
