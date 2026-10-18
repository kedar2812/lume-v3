"use client";
import { formatPhone } from "@lume/core/shared";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useToast } from "@/components/feedback/ToastProvider";
import { Avatar } from "@/components/ui/Avatar";
import { Button } from "@/components/ui/Button";
import { nearDay, timeOf } from "@/lib/dates";
import { whatsappClient } from "@/lib/whatsapp/client";
import type { WaInboxMessage, WaPerson } from "@/lib/whatsapp/types";
import s from "./notyet.module.css";

const keyOf = (p: WaPerson) => `${p.number.id}:${p.peer}`;
const nameOf = (p: WaPerson) => p.name ?? formatPhone(p.peer);

/**
 * Not a lead yet (spec 2026-10-18 §4.1; canvas board NotYet): messages from numbers no lead has, newest first. LUME
 * never makes them leads by itself: a person makes one an enquiry, or says it's not a lead (and it never shows again).
 */
export function NotYet({ tz }: { tz: string }) {
  const router = useRouter();
  const { toast } = useToast();
  const [people, setPeople] = useState<WaPerson[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [messages, setMessages] = useState<WaInboxMessage[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    void whatsappClient.inbox().then((r) => {
      if (!r.ok) return setProblem(r.message);
      setPeople(r.data.people);
      setOpen((o) => o ?? (r.data.people[0] ? keyOf(r.data.people[0]) : null));
    });
  }, []);
  const current = people?.find((p) => keyOf(p) === open) ?? null;
  useEffect(() => {
    setMessages(null);
    if (!current) return;
    let live = true;
    void whatsappClient
      .inboxPerson(current.number.id, current.peer)
      .then((r) => live && r.ok && setMessages(r.data.messages));
    return () => {
      live = false;
    };
  }, [current?.number.id, current?.peer]);

  const makeLead = async (p: WaPerson) => {
    setBusy(true);
    setProblem(null);
    const r = await whatsappClient.makeLead(p.number.id, p.peer);
    setBusy(false);
    if (!r.ok) return setProblem(r.message);
    toast({ tone: "ok", title: "Made it an enquiry", detail: nameOf(p) });
    router.push(`/leads?lead=${r.data.leadId}`);
  };
  const ignore = async (p: WaPerson) => {
    setBusy(true);
    setProblem(null);
    const r = await whatsappClient.ignore(p.number.id, p.peer);
    setBusy(false);
    if (!r.ok) return setProblem(r.message);
    toast({ tone: "ok", title: "Not a lead", detail: "LUME won’t show this number here again." });
    const rest = (people ?? []).filter((x) => keyOf(x) !== keyOf(p));
    setPeople(rest);
    setOpen(rest[0] ? keyOf(rest[0]) : null);
  };

  if (problem && !people)
    return (
      <p role="alert" className={s.problem}>
        {problem}
      </p>
    );
  if (!people) return <div className={s.loading} aria-busy="true" />;
  if (!people.length)
    return <p className={s.empty}>Nobody&rsquo;s waiting. Messages from numbers no lead has show up here.</p>;

  return (
    <div className={s.layout}>
      <ul className={s.people} aria-label="People who wrote">
        {people.map((p) => (
          <li key={keyOf(p)}>
            <a
              href="#"
              className={s.person}
              aria-current={keyOf(p) === open ? "true" : undefined}
              onClick={(e) => {
                e.preventDefault();
                setOpen(keyOf(p));
              }}
            >
              <Avatar name={p.name ?? "+"} size={36} />
              <span className={s.personText}>
                <span className={s.personTop}>
                  <b>{nameOf(p)}</b>
                  <span className={s.when}>{nearDay(new Date(p.lastAt), tz)}</span>
                </span>
                <span className={s.last}>{p.lastText ?? "Sent a photo or a file"}</span>
                <span className={s.where}>
                  {p.name ? `${formatPhone(p.peer)} · ` : ""}to {p.number.display} · {p.count}{" "}
                  {p.count === 1 ? "message" : "messages"}
                </span>
              </span>
            </a>
          </li>
        ))}
      </ul>
      {current && (
        <section className={s.detail} aria-labelledby="ny-person">
          <header className={s.detailHead}>
            <div className={s.detailWho}>
              <h2 id="ny-person">{nameOf(current)}</h2>
              <span>
                {current.name ? `${formatPhone(current.peer)} · ` : ""}wrote to {current.number.display}
              </span>
            </div>
            <Button disabled={busy} onClick={() => void ignore(current)}>
              Not a lead
            </Button>
            <Button variant="primary" loading={busy} onClick={() => void makeLead(current)}>
              Make it an enquiry
            </Button>
          </header>
          {problem && (
            <p role="alert" className={s.problem}>
              {problem}
            </p>
          )}
          <ol className={s.messages} aria-label={`Messages from ${nameOf(current)}`}>
            {(messages ?? []).map((m) => (
              <li key={m.id} className={s.message}>
                <span className={s.meta}>
                  {timeOf(new Date(m.at), tz)}
                  <span className={s.srOnly}>: </span>
                </span>
                <span className={s.bubble}>
                  {m.text ?? "Sent a photo or a file. Make it an enquiry to see it."}
                </span>
              </li>
            ))}
          </ol>
          <p className={s.hint}>
            Make it an enquiry: LUME makes a lead with this name and number, owned like the number it came to,
            with these messages on it. Not a lead: they go, and this number never shows up here again.
          </p>
        </section>
      )}
    </div>
  );
}
