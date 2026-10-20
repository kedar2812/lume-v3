import { redirect } from "next/navigation";

/** Settings → Files moved to Media, in the sidebar (2026-10-20): an old link or bookmark lands there. */
export default function Page() {
  redirect("/media");
}
