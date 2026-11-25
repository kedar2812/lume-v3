"use client";
import { formatPhone } from "@lume/core/shared";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useToast } from "@/components/feedback/ToastProvider";
import { Avatar } from "@/components/ui/Avatar";
import { Button } from "@/components/ui/Button";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { nearDay, timeOf } from "@/lib/dates";
import { instagramClient } from "@/lib/instagram/client";
import type { IgInboxPerson } from "@/lib/instagram/types";
import { detailWords } from "@/lib/instagram/words";
import { whatsappClient } from "@/lib/whatsapp/client";
import type { WaPerson } from "@/lib/whatsapp/types";
import s from "./notyet.module.css";

/** Instagram's page of people (the API's PAGE): a full one means there may be older ones. */
const IG_PAGE = 100;

type Channel = "whatsapp" | "instagram";
/** Someone waiting, from either channel, said the same way. */
type Entry = {
  ch: Channel;
  key: string;
  name: string;
  /** Under the name: their number, or their handle, when the name is something else. */
  sub: string | null;
  /** Where they wrote: the number or the account. */
  to: string;
  count: number;
  lastText: string | null;
  lastAt: string;
  wa?: WaPerson;
  ig?: IgInboxPerson;
};
type Msg = { id: string; at: string; words: string; extra: string[] };

const fromWa = (p: WaPerson): Entry => ({
  ch: "whatsapp",
  key: `wa:${p.number.id}:${p.peer}`,
  name: p.name ?? formatPhone(p.peer),
  sub: p.name ? formatPhone(p.peer) : null,
  to: p.number.display,
  count: p.count,
  lastText: p.lastText,
  lastAt: p.lastAt,
  wa: p,
});
const fromIg = (p: IgInboxPerson): Entry => ({
  ch: "instagram",
  key: `ig:${p.threadId}`,
  name: p.name ?? (p.username ? `@${p.username}` : "Someone on Instagram"),
  sub: p.name && p.username ? `@${p.username}` : null,
  to: `@${p.account.username}`,
  count: p.count,
  lastText: p.lastText,
  lastAt: p.lastAt,
  ig: p,
});
const newestFirst = (a: Entry, b: Entry) => b.lastAt.localeCompare(a.lastAt);
const CHANNEL: Record<Channel, string> = { whatsapp: "WhatsApp", instagram: "Instagram" };

/**
 * Not a lead yet (spec 2026-10-18 §4.1; plan 2026-11-25-instagram-screens D5; canvas board NotYet): people no lead has
 * yet, from WhatsApp and Instagram, newest first. LUME never makes them leads by itself: a person makes one an enquiry,
 * or says it's not a lead (and it never shows again). Who it shows is the API's to decide, channel by channel.
 */
/** `mayDecide`: the person may add leads, so may make one of these, or ignore them (which deletes what they sent). */
export function NotYet({ tz, mayDecide = true }: { tz: string; mayDecide?: boolean }) {
  const router = useRouter();
  const { toast } = useToast();
  const [wa, setWa] = useState<Entry[] | null>(null);
  const [ig, setIg] = useState<Entry[] | null>(null);
  const [igMore, setIgMore] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [ch, setCh] = useState<"all" | Channel>("all");
  const [open, setOpen] = useState<string | null>(null);
  const [messages, setMessages] = useState<Msg[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    void Promise.all([whatsappClient.inbox(), instagramClient.inbox()]).then(([w, i]) => {
      // A channel that's off, or not this person's to see, simply has nobody; both unreadable is said.
      setWa(w.ok ? w.data.people.map(fromWa) : []);
      setIg(i.ok ? i.data.people.map(fromIg) : []);
      setIgMore(i.ok && i.data.people.length >= IG_PAGE);
      // WhatsApp that couldn't be read is said whatever Instagram answered (its inbox answers empty when it's off).
      if (!w.ok && (w.status === 0 || w.status >= 500)) setFailed(w.message);
      else if (!i.ok && (i.status === 0 || i.status >= 500)) setFailed(i.message);
    });
  }, []);

  const all = wa && ig ? [...wa, ...ig].sort(newestFirst) : null;
  const shown = all?.filter((e) => ch === "all" || e.ch === ch) ?? null;
  const current = shown?.find((e) => e.key === open) ?? shown?.[0] ?? null;
  // The one open, read when its key changes (the list around it changes more often than who's open).
  const opened = useRef(current);
  opened.current = current;
  const openKey = current?.key ?? null;

  useEffect(() => {
    setMessages(null);
    const current = opened.current;
    if (!current) return;
    let live = true;
    if (current.wa)
      void whatsappClient.inboxPerson(current.wa.number.id, current.wa.peer).then(
        (r) =>
          live &&
          r.ok &&
          setMessages(
            r.data.messages.map((m) => ({
              id: m.id,
              at: m.at,
              words: m.text ?? "Sent a photo or a file. Make it an enquiry to see it.",
              extra: [],
            })),
          ),
      );
    else if (current.ig)
      void instagramClient.inboxPerson(current.ig.threadId).then(
        (r) =>
          live &&
          r.ok &&
          setMessages(
            r.data.messages.map((m) => ({
              id: m.id,
              at: m.at,
              words: m.unsent ? "Unsent" : (m.text ?? ""),
              extra: m.unsent ? [] : detailWords(m.detail),
            })),
          ),
      );
    return () => {
      live = false;
    };
  }, [openKey]);

  const drop = (e: Entry) => {
    if (e.ch === "whatsapp") setWa((x) => (x ?? []).filter((y) => y.key !== e.key));
    else setIg((x) => (x ?? []).filter((y) => y.key !== e.key));
    setOpen(null);
  };
  // What went wrong belongs to the person it was about: another one opened clears it.
  useEffect(() => setProblem(null), [openKey]);
  const makeLead = async (e: Entry) => {
    setBusy(true);
    setProblem(null);
    const r = e.wa
      ? await whatsappClient.makeLead(e.wa.number.id, e.wa.peer)
      : await instagramClient.makeLead(e.ig!.threadId);
    setBusy(false);
    if (!r.ok) {
      // Made a lead somewhere else meanwhile, or cleared: nothing of theirs is waiting any more, said where it shows.
      if (r.status === 404) {
        toast({ tone: "danger", title: "Already gone", detail: r.message });
        drop(e);
      } else setProblem(r.message);
      return;
    }
    toast({ tone: "ok", title: "Made it an enquiry", detail: e.name });
    router.push(`/leads?lead=${r.data.leadId}`);
  };
  const ignore = async (e: Entry) => {
    setBusy(true);
    setProblem(null);
    const r = e.wa
      ? await whatsappClient.ignore(e.wa.number.id, e.wa.peer)
      : await instagramClient.ignore(e.ig!.threadId);
    setBusy(false);
    if (!r.ok) return setProblem(r.message);
    toast({
      tone: "ok",
      title: "Not a lead",
      detail:
        e.ch === "whatsapp"
          ? "LUME won’t show this number here again."
          : "LUME won’t show this person here again.",
    });
    drop(e);
  };
  const fetching = useRef(false);
  const older = async () => {
    const last = ig?.at(-1);
    if (!last || fetching.current) return;
    fetching.current = true;
    const r = await instagramClient.inbox(last.lastAt);
    fetching.current = false;
    if (!r.ok) return setProblem(r.message);
    setIg((x) => {
      const seen = new Set((x ?? []).map((e) => e.key));
      return [...(x ?? []), ...r.data.people.map(fromIg).filter((e) => !seen.has(e.key))];
    });
    setIgMore(r.data.people.length >= IG_PAGE);
  };

  if (failed)
    return (
      <p role="alert" className={s.problem}>
        {failed}
      </p>
    );
  if (!all || !shown) return <div className={s.loading} aria-busy="true" />;
  if (!all.length)
    return (
      <p className={s.empty}>
        Nobody&rsquo;s waiting. Messages from people who aren&rsquo;t leads yet show up here.
      </p>
    );

  const both = !!wa?.length && !!ig?.length;
  return (
    <>
      {both && (
        <SegmentedControl
          label="Channel"
          size="sm"
          value={ch}
          onChange={(v) => {
            setCh(v);
            setOpen(null);
          }}
          options={[
            { value: "all", label: `All · ${all.length}` },
            { value: "whatsapp", label: `WhatsApp · ${wa!.length}` },
            { value: "instagram", label: `Instagram · ${ig!.length}` },
          ]}
        />
      )}
      <div className={s.layout}>
        <div>
          <ul className={s.people} aria-label="People who wrote">
            {shown.map((e) => (
              <li key={e.key}>
                <a
                  href="#"
                  className={s.person}
                  aria-current={e.key === current?.key ? "true" : undefined}
                  onClick={(ev) => {
                    ev.preventDefault();
                    setOpen(e.key);
                  }}
                >
                  <Avatar name={e.name} size={36} />
                  <span className={s.personText}>
                    <span className={s.personTop}>
                      <b title={e.name}>{e.name}</b>
                      <span className={s.when}>{nearDay(new Date(e.lastAt), tz)}</span>
                    </span>
                    <span className={s.last}>{e.lastText ?? "Sent a photo or a file"}</span>
                    <span className={s.where}>
                      {e.sub ? `${e.sub} · ` : ""}
                      {CHANNEL[e.ch]} · to {e.to} · {e.count} {e.count === 1 ? "message" : "messages"}
                    </span>
                  </span>
                </a>
              </li>
            ))}
          </ul>
          {igMore && ch !== "whatsapp" && (
            <Button size="sm" variant="ghost" onClick={() => void older()}>
              Show older
            </Button>
          )}
        </div>
        {current && (
          <section className={s.detail} aria-labelledby="ny-person">
            <header className={s.detailHead}>
              <div className={s.detailWho}>
                <h2 id="ny-person" title={current.name}>
                  {current.name}
                </h2>
                <span>
                  {current.sub ? `${current.sub} · ` : ""}wrote to {current.to} on {CHANNEL[current.ch]}
                </span>
              </div>
              {mayDecide ? (
                <>
                  <Button disabled={busy} onClick={() => void ignore(current)}>
                    Not a lead
                  </Button>
                  <Button variant="primary" loading={busy} onClick={() => void makeLead(current)}>
                    Make it an enquiry
                  </Button>
                </>
              ) : (
                <p className={s.where}>Someone who can add leads decides who becomes one.</p>
              )}
            </header>
            {problem && (
              <p role="alert" className={s.problem}>
                {problem}
              </p>
            )}
            <ol className={s.messages} aria-label={`Messages from ${current.name}`}>
              {(messages ?? []).map((m) => (
                <li key={m.id} className={s.message}>
                  <span className={s.meta}>
                    {timeOf(new Date(m.at), tz)}
                    <span className={s.srOnly}>: </span>
                  </span>
                  <span className={s.bubble}>
                    {m.extra.map((x) => (
                      <span key={x} className={s.extra}>
                        {x}
                      </span>
                    ))}
                    {m.words}
                  </span>
                </li>
              ))}
            </ol>
            <p className={s.hint}>
              {current.ch === "whatsapp"
                ? "Make it an enquiry: LUME makes a lead with this name and number, owned like the number it came to, with these messages on it. Not a lead: they go, and this number never shows up here again."
                : "Make it an enquiry: LUME makes a lead with this name and handle, owned like the account it came to, with these messages on it. Not a lead: they go, and this person never shows up here again."}
            </p>
          </section>
        )}
      </div>
    </>
  );
}
