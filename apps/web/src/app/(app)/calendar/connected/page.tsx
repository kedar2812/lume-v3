import { Suspense } from "react";
import { CalendarConnected } from "@/components/calendar/ConnectCalendar";
import { requirePermission } from "@/server/session";

export const metadata = { title: "Connecting your calendar · LUME" };

/** The relay hands a calendar back here (`?p=&s=`): finish it once, then return to where it began. */
export default async function Page() {
  await requirePermission("calendar.connect");
  return (
    <section data-stagger style={{ padding: "72px 16px" }}>
      <Suspense>
        <CalendarConnected />
      </Suspense>
    </section>
  );
}
