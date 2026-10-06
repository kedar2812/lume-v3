"use client";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/client";
import { when } from "@/lib/format";
import { Toast, useToast } from "./bits";
import { EnquiryPill, STATUS_WORDS, TEAM_WORDS, type Enquiry, type Status } from "./EnquiriesScreen";
import { Head } from "./Shell";

const ORDER: Status[] = ["new", "contacted", "demo_booked", "won", "not_a_fit"];

/** One enquiry (website spec §7): who, how leads reach them, a status saved at once, notes, and a way to reply. */
export function EnquiryScreen({ id }: { id: string }) {
  const [e, setE] = useState<Enquiry | null>(null);
  const [missing, setMissing] = useState(false);
  const [stale, setStale] = useState<string | null>(null);
  const [notes, setNotes] = useState("");
  const [toast, say] = useToast();
  const load = useCallback(() => {
    void api.get<{ enquiry: Enquiry }>(`/api/enquiries/${id}`).then((r) => {
      if (!r.ok) return setMissing(true);
      setE(r.data.enquiry);
      setNotes(r.data.enquiry.notes);
      setStale(null);
    });
  }, [id]);
  useEffect(load, [load]);

  const save = async (patch: { status?: Status; notes?: string }) => {
    if (!e) return;
    const r = await api.patch<{ enquiry: Enquiry }>(`/api/enquiries/${e.id}`, {
      ...patch,
      expectedUpdatedAt: e.updatedAt,
    });
    if (r.ok) {
      setE(r.data.enquiry);
      say("Saved");
    } else if (r.status === 409) setStale(r.message);
    else say(r.message);
  };

  const back = (
    <Link className="back" href="/enquiries">
      ← Enquiries
    </Link>
  );
  if (missing) return <Head title="No such enquiry" back={back} sub="It may have been removed." />;
  if (!e) return <Head title="" back={back} />;
  const digits = e.whatsapp.replace(/\D/g, "");
  return (
    <>
      <Head title={e.name} back={back} sub={e.business}>
        <EnquiryPill status={e.status} />
      </Head>
      <div className="body">
        {stale && (
          <p role="alert" className="card" style={{ display: "flex", gap: 12, alignItems: "center" }}>
            {stale}
            <button type="button" className="btn small" onClick={load}>
              Reload
            </button>
          </p>
        )}
        <section className="card">
          <h2 className="h">Status</h2>
          <div className="seg" role="radiogroup" aria-label="Status" style={{ width: "max-content" }}>
            {ORDER.map((st) => (
              <button
                key={st}
                type="button"
                role="radio"
                aria-checked={e.status === st}
                tabIndex={e.status === st ? 0 : -1}
                onClick={() => void save({ status: st })}
                style={{ padding: "0 12px" }}
              >
                {STATUS_WORDS[st]}
              </button>
            ))}
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
            <a className="btn" href={`https://wa.me/${digits}`} target="_blank" rel="noopener noreferrer">
              WhatsApp
            </a>
            {e.email && (
              <a className="btn" href={`mailto:${e.email}`}>
                Email
              </a>
            )}
          </div>
        </section>
        <section className="card">
          <h2 className="h">What they said</h2>
          <dl
            style={{
              display: "grid",
              gridTemplateColumns: "180px minmax(0, 1fr)",
              gap: "10px 16px",
              margin: 0,
            }}
          >
            <dt>WhatsApp</dt>
            <dd className="num">{e.whatsapp}</dd>
            {e.email && (
              <>
                <dt>Email</dt>
                <dd>{e.email}</dd>
              </>
            )}
            <dt>Team</dt>
            <dd>{TEAM_WORDS[e.teamSize] ?? e.teamSize}</dd>
            <dt>How leads reach them</dt>
            <dd>{e.how ?? "—"}</dd>
            <dt>Asked</dt>
            <dd>{when(e.createdAt)}</dd>
          </dl>
        </section>
        <section className="card">
          <label className="field" style={{ display: "block" }}>
            <span className="h">Notes</span>
            <textarea
              className="input"
              rows={5}
              value={notes}
              onChange={(ev) => setNotes(ev.target.value)}
              onBlur={() => notes !== e.notes && void save({ notes })}
              placeholder="Called, demo on Thursday at 4…"
            />
          </label>
        </section>
      </div>
      <Toast msg={toast} />
    </>
  );
}
