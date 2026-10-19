import { useSearchParams } from "next/navigation";
import { useEffect } from "react";

/**
 * The lead the address asks for (`?lead=`), followed for as long as the screen shows. A link to a lead from the page
 * already showing (the search palette, a notification's Open) renders the screen again without remounting it, so a
 * `?lead=` read only on the first render was ignored: the pick closed the palette and opened nothing. Closing the
 * drawer takes `lead` out of the address, so the same lead picked again is a change too.
 */
export function useAskedLead(open: (id: string) => void): void {
  const asked = useSearchParams().get("lead");
  useEffect(() => {
    if (asked) open(asked);
  }, [asked, open]);
}
