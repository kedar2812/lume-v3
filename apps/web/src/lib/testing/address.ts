import { useSyncExternalStore } from "react";

// Tests only. Next's useSearchParams as Next behaves since 14.1: it follows the address, including the screen's own
// history.pushState and replaceState, and renders again when it changes. A mock that reads the address only when
// something else renders would let a test pass (or fail) on an order of renders the app never has.
const listeners = new Set<() => void>();
let patched = false;

function patchHistory() {
  if (patched) return;
  patched = true;
  for (const method of ["pushState", "replaceState"] as const) {
    const original = window.history[method].bind(window.history);
    window.history[method] = (...args: Parameters<History["pushState"]>) => {
      original(...args);
      for (const l of listeners) l();
    };
  }
}

export function useAddressSearchParams(): URLSearchParams {
  patchHistory();
  const search = useSyncExternalStore(
    (changed) => {
      listeners.add(changed);
      return () => listeners.delete(changed);
    },
    () => window.location.search,
  );
  return new URLSearchParams(search);
}
