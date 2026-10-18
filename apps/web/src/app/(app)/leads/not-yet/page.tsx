import Link from "next/link";
import { NotYet } from "@/components/whatsapp/NotYet";
import s from "@/components/whatsapp/notyet.module.css";
import { zoneOf } from "@/lib/zone";
import { requireSession } from "@/server/session";

export const metadata = { title: "Not a lead yet · Leads · LUME" };

/** Not a lead yet (spec 2026-10-18 §4.1): who it shows is the API's to decide (a number's owner, or who sees every lead). */
export default async function Page() {
  const session = await requireSession();
  return (
    <section className={s.page} data-stagger>
      <nav aria-label="Breadcrumb" className={s.crumbs}>
        <Link href="/leads">Leads</Link> <span aria-hidden>›</span> Not a lead yet
      </nav>
      <header className={s.pageHead}>
        <h1>Not a lead yet</h1>
        <p>
          Messages from numbers no lead has. LUME never makes them leads by itself, and clears them after 14
          days.
        </p>
      </header>
      <NotYet tz={zoneOf(session.user)} />
    </section>
  );
}
