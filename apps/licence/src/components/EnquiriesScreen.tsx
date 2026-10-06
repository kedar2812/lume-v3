"use client";
import Link from "next/link";
import { useEffect, useState, type KeyboardEvent } from "react";
import { api, CHANGED } from "@/lib/client";
import { day } from "@/lib/format";
import { Bell } from "./Bell";
import { Head } from "./Shell";

export type Status = "new" | "contacted" | "demo_booked" | "won" | "not_a_fit";
export type Enquiry = {
  id: string;
  createdAt: string;
  name: string;
  business: string;
  whatsapp: string;
  email: string | null;
  teamSize: string;
  how: string | null;
  source: "website";
  status: Status;
  notes: string;
  updatedAt: string;
};
/** The statuses in words, in the order an enquiry moves through them. */
export const STATUS_WORDS: Record<Status, string> = {
  new: "New",
  contacted: "Contacted",
  demo_booked: "Demo booked",
  won: "Won",
  not_a_fit: "Not a fit",
};
export const TEAM_WORDS: Record<string, string> = {
  "1": "Just me",
  "2-5": "2–5",
  "6-20": "6–20",
  "21+": "21+",
};
const FILTERS: (Status | "all")[] = ["all", "new", "contacted", "demo_booked", "won", "not_a_fit"];

export function EnquiryPill({ status }: { status: Status }) {
  return (
    <span className={`pill enq-${status}`}>
      <i />
      {STATUS_WORDS[status]}
    </span>
  );
}

/** Enquiries (website spec §7): who asked for a demo on lumecrm.in, newest first, with where you've got to. */
export function EnquiriesScreen() {
  const [filter, setFilter] = useState<Status | "all">("all");
  const [list, setList] = useState<Enquiry[] | null>(null);
  useEffect(() => {
    const load = () =>
      void api
        .get<{ enquiries: Enquiry[]; newCount: number }>(`/api/enquiries?status=${filter}`)
        .then((r) => r.ok && setList(r.data.enquiries));
    load();
    window.addEventListener(CHANGED, load);
    return () => window.removeEventListener(CHANGED, load);
  }, [filter]);
  const move = (e: KeyboardEvent) => {
    const i = FILTERS.indexOf(filter);
    const step =
      e.key === "ArrowRight" || e.key === "ArrowDown"
        ? 1
        : e.key === "ArrowLeft" || e.key === "ArrowUp"
          ? -1
          : 0;
    if (!step) return;
    e.preventDefault();
    const next = FILTERS[(i + step + FILTERS.length) % FILTERS.length]!;
    setFilter(next);
    (e.currentTarget.querySelector(`[data-f="${next}"]`) as HTMLElement | null)?.focus();
  };
  return (
    <>
      <Head title="Enquiries" sub="Who asked for a demo on lumecrm.in, newest first.">
        <Bell />
      </Head>
      <div className="body">
        <div
          className="seg"
          role="radiogroup"
          aria-label="Status"
          onKeyDown={move}
          style={{ width: "max-content" }}
        >
          {FILTERS.map((f) => (
            <button
              key={f}
              type="button"
              role="radio"
              data-f={f}
              aria-checked={filter === f}
              tabIndex={filter === f ? 0 : -1}
              onClick={() => setFilter(f)}
              style={{ padding: "0 12px" }}
            >
              {f === "all" ? "All" : STATUS_WORDS[f]}
            </button>
          ))}
        </div>
        {list && list.length === 0 && (
          <section className="card">
            <p className="note">No enquiries yet. They arrive here from lumecrm.in.</p>
          </section>
        )}
        {list && list.length > 0 && (
          <section className="card" style={{ padding: 8 }}>
            <table className="list">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Name</th>
                  <th>Business</th>
                  <th>Team</th>
                  <th>WhatsApp</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {list.map((e) => (
                  <tr key={e.id}>
                    <td className="num">{day(e.createdAt.slice(0, 10))}</td>
                    <td>
                      <Link href={`/enquiries/${e.id}`} style={{ fontWeight: 600, textDecoration: "none" }}>
                        {e.name}
                      </Link>
                    </td>
                    <td>{e.business}</td>
                    <td>{TEAM_WORDS[e.teamSize] ?? e.teamSize}</td>
                    <td className="num">{e.whatsapp}</td>
                    <td>
                      <EnquiryPill status={e.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )}
      </div>
    </>
  );
}
