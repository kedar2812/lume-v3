import { Suspense } from "react";
import { LiveSheetsConnected } from "@/components/live-sheets/LiveSheetsConnected";
import { requirePermission } from "@/server/session";

export const metadata = { title: "Connecting Google · LUME" };

/** The relay hands a live sheet's Google account back here (`?p=&s=`): finish it once, then back to the form. */
export default async function Page() {
  await requirePermission("leads.live_sheets");
  return (
    <section data-stagger style={{ padding: "72px 16px" }}>
      <Suspense>
        <LiveSheetsConnected />
      </Suspense>
    </section>
  );
}
