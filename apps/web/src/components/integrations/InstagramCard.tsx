"use client";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { usePlan } from "@/components/licence/LicenceProvider";
import { Avatar } from "@/components/ui/Avatar";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { ICON_SIZE, UI_ICONS } from "@/components/ui/icons";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { Skeleton } from "@/components/ui/Skeleton";
import { Switch } from "@/components/ui/Switch";
import { shortDate } from "@/lib/dates";
import { instagramClient } from "@/lib/instagram/client";
import { instagramSwitched } from "@/lib/instagram/use-instagram-on";
import type { IgAccount } from "@/lib/instagram/types";
import type { IntegrationsView } from "@/lib/sheets/types";
import { NOT_IN_PLAN_NOTE, NotInPlanPill, inPlan } from "./NotInPlan";
import s from "./integrations.module.css";

type IgView = NonNullable<IntegrationsView["instagram"]>;
const BUSINESS = "";
const NEW_PEOPLE = [
  { value: "leads", label: "Become leads" },
  { value: "wait", label: "Wait in Not a lead yet" },
] as const;

/** What connecting does, said before anything happens (canvas board Connect, "before"). */
const POINTS = [
  {
    icon: UI_ICONS.arriving,
    title: "DMs, comments, story replies and ad clicks",
    text: "Each lands on its lead, and your team or a flow answers from LUME.",
  },
  {
    icon: UI_ICONS.private,
    title: "Kept on your own server",
    text: "Messages are stored only in this LUME. LUME’s relay passes them on and keeps none of them.",
  },
  {
    icon: UI_ICONS.rules,
    title: "Inside Instagram’s rules",
    text: "Answers within 24 hours of a person’s last message; a person can answer up to 7 days. Nobody is messaged first.",
  },
] as const;

/**
 * Who answers, in the order LUME applies it (spec 2026-11-22 §2; board Main). LUME AI joins as the third line once it
 * can answer on Instagram (plan 2026-11-25-instagram-screens, Part E); until then it isn't offered.
 */
const ORDER = [
  {
    title: "Your team, once someone steps in",
    text: "Typing in a conversation takes it over from a flow, at once.",
  },
  {
    title: "A flow, for what it was made for",
    text: "Its keyword, story reply or ad. A flow can pass the person to your team when it ends.",
  },
  {
    title: "Your team, for everything else",
    text: "DMs no flow claims wait on their lead, or in Not a lead yet, for your team to answer.",
  },
] as const;

function ConnectSheet({ onClose }: { onClose(): void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const Warn = UI_ICONS.warning;
  const Out = UI_ICONS.external;
  const go = async () => {
    setBusy(true);
    setError(null);
    const r = await instagramClient.connect();
    if (!r.ok) {
      setBusy(false);
      return setError(r.message);
    }
    // This window, as WhatsApp's: a pop-up is one more thing a blocker or a phone can swallow.
    window.location.assign(r.data.url);
  };
  return (
    <Dialog label="Connect an Instagram account" onClose={onClose} wide>
      <div className={s.waSheet}>
        <div className={s.waSheetHead}>
          <span className={s.brandTile}>
            <img src="/brand/instagram.png" alt="" width={28} height={28} />
          </span>
          <h2 className={s.waSheetTitle}>Connect an Instagram account</h2>
        </div>
        <p className={s.waSheetText}>
          You’ll sign in on Instagram and choose the account. It must be a professional account (Business or
          Creator).
        </p>
        <ul className={s.igPoints}>
          {POINTS.map(({ icon: Icon, title, text }) => (
            <li key={title}>
              <span className={s.igPointIcon} aria-hidden>
                <Icon size={ICON_SIZE.md} />
              </span>
              <span className={s.waChangeText}>
                <b>{title}</b>
                <small>{text}</small>
              </span>
            </li>
          ))}
        </ul>
        <p className={s.igWarn}>
          <Warn size={ICON_SIZE.md} aria-hidden />
          <span>
            Using ManyChat on this account too? Both would answer the same keyword. Keep each keyword in one
            of them.
          </span>
        </p>
        {error && (
          <p role="alert" className={s.error}>
            {error}
          </p>
        )}
        <div className={s.waSheetFoot}>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} onClick={() => void go()}>
            Continue to Instagram
            <Out size={ICON_SIZE.md} aria-hidden />
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

/**
 * Settings → Integrations → Instagram (plan 2026-11-25-instagram-screens D1; canvas boards Main, Connect): the switch,
 * the accounts connected, whose each is and what happens to new people who write, and connecting another.
 */
export function InstagramCard({
  ig,
  onView,
  tz = Intl.DateTimeFormat().resolvedOptions().timeZone,
}: {
  ig: IgView;
  onView(v: IntegrationsView): void;
  /** The person's own zone, for when each account was connected. */
  tz?: string;
}) {
  const out = !inPlan(usePlan(), "instagram") || !ig.inPlan;
  const usable = ig.available && !out;
  const on = ig.enabled && usable;
  const [accounts, setAccounts] = useState<IgAccount[] | null>(null);
  const [people, setPeople] = useState<{ id: string; name: string }[]>([]);
  const [connecting, setConnecting] = useState(false);
  const [leaving, setLeaving] = useState<IgAccount | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);

  const load = useCallback(async () => {
    setLoadFailed(false);
    const [a, p] = await Promise.all([instagramClient.accounts(), instagramClient.people()]);
    if (a.ok) setAccounts(a.data.accounts);
    else setLoadFailed(true);
    if (p.ok) setPeople(p.data.people.filter((x) => x.active));
  }, []);
  useEffect(() => {
    if (on) void load();
    else setAccounts(null);
  }, [on, load]);

  const toggle = async (enabled: boolean) => {
    setError(null);
    const r = await instagramClient.setEnabled(enabled);
    if (!r.ok) return setError(r.message);
    instagramSwitched(enabled);
    onView(r.data);
  };
  const change = async (a: IgAccount, b: { ownerId?: string | null; newDmCreatesLead?: boolean }) => {
    setError(null);
    const r = await instagramClient.setAccount(a.id, b);
    if (!r.ok) return setError(r.message);
    setAccounts(r.data.accounts);
  };
  const [leavingBusy, setLeavingBusy] = useState(false);
  const disconnect = async (a: IgAccount) => {
    if (leavingBusy) return;
    setLeavingBusy(true);
    setError(null);
    const r = await instagramClient.disconnect(a.id);
    setLeavingBusy(false);
    setLeaving(null);
    if (!r.ok) return setError(r.message);
    setAccounts(r.data.accounts);
  };

  const n = accounts?.length ?? 0;
  return (
    <article id="instagram" className={s.card} aria-labelledby="ig-title">
      <header className={s.cardHead}>
        <span className={s.brandTile}>
          <img src="/brand/instagram.png" alt="" width={28} height={28} />
        </span>
        <div className={s.cardText}>
          <h2 id="ig-title" className={s.cardTitle}>
            Instagram
            {out && <NotInPlanPill />}
          </h2>
          <p className={s.cardLede}>
            {out
              ? NOT_IN_PLAN_NOTE
              : !ig.available
                ? "Instagram comes through LUME’s relay, which isn’t set up on this server yet."
                : on && accounts === null
                  ? loadFailed
                    ? "Couldn’t check the accounts"
                    : "Looking for accounts…"
                  : n
                    ? `${n} ${n === 1 ? "account" : "accounts"} connected`
                    : "Not connected yet"}
          </p>
        </div>
        <Switch
          checked={on}
          onChange={(v) => void toggle(v)}
          label={
            out
              ? "Instagram, not in this LUME’s plan"
              : !ig.available
                ? "Instagram, not set up here"
                : "Instagram"
          }
          labelHidden
          disabled={!usable}
        />
      </header>
      {error && (
        <p role="alert" className={s.error}>
          {error}
        </p>
      )}
      {on && accounts === null && loadFailed && (
        <div className={s.waEmpty}>
          <p role="alert">LUME couldn't get your Instagram accounts. Check your connection and try again.</p>
          <Button onClick={() => void load()}>Try again</Button>
        </div>
      )}
      {on && accounts === null && !loadFailed && (
        <div className={s.waEmpty} role="status" aria-label="Looking for connected accounts" aria-busy="true">
          <Skeleton width="40%" height={14} />
          <Skeleton width={220} height={34} radius={10} />
        </div>
      )}
      {on && accounts && n === 0 && (
        <div className={s.igEmpty}>
          <b>Turn Instagram comments and DMs into leads</b>
          <p>
            Connect a professional account and every DM, comment, story reply and ad click lands on its lead.
            Flows answer in seconds; your team takes it from there.
          </p>
          <Button variant="primary" onClick={() => setConnecting(true)}>
            Connect an Instagram account
          </Button>
        </div>
      )}
      {on && accounts && n > 0 && (
        <>
          <ul className={s.waNumbers} aria-label="Connected accounts">
            {accounts.map((a) => {
              const handle = `@${a.username}`;
              const wait = !a.newDmCreatesLead;
              return (
                <li key={a.id} className={s.waNumber}>
                  <div className={s.waRow}>
                    <Avatar name={a.name || a.username} size={36} />
                    <div className={s.waWho}>
                      <span className={s.igHandle} title={handle}>
                        {handle}
                      </span>
                      <span className={s.igMeta} data-volatile>
                        {[a.name, `Connected ${shortDate(new Date(a.connectedAt), tz).replace(/, \w+$/, "")}`]
                          .filter(Boolean)
                          .join(" · ")}
                      </span>
                    </div>
                    <label className={s.waOwner}>
                      <span>Whose account</span>
                      <select
                        aria-label={`Whose account is ${handle}?`}
                        value={a.owner?.id ?? BUSINESS}
                        onChange={(e) =>
                          void change(a, { ownerId: e.target.value === BUSINESS ? null : e.target.value })
                        }
                      >
                        <option value={BUSINESS}>The business</option>
                        {/* Someone who has left still shows as the owner until it changes. */}
                        {a.owner && !people.some((p) => p.id === a.owner!.id) && (
                          <option value={a.owner.id}>{a.owner.name}</option>
                        )}
                        {people.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={`Disconnect ${handle}`}
                      onClick={() => setLeaving(a)}
                    >
                      Disconnect
                    </Button>
                  </div>
                  {a.status === "needs_attention" && (
                    <div role="status" className={s.waAttention}>
                      <span>{a.problem ?? "This account needs connecting again."}</span>
                      <Button
                        size="sm"
                        aria-label={`Connect ${handle} again`}
                        onClick={() => setConnecting(true)}
                      >
                        Connect again
                      </Button>
                    </div>
                  )}
                  <div className={s.igQuestion}>
                    <span className={s.igQuestionTitle}>New people who write</span>
                    <SegmentedControl
                      label="New people who write"
                      size="sm"
                      value={wait ? "wait" : "leads"}
                      options={NEW_PEOPLE}
                      onChange={(v) => void change(a, { newDmCreatesLead: v === "leads" })}
                    />
                    <p className={s.igQuestionNote}>
                      {wait
                        ? "They wait in Not a lead yet for 14 days until someone makes them a lead."
                        : "Each becomes a lead under the account’s source, with its owner rule."}
                    </p>
                  </div>
                </li>
              );
            })}
          </ul>
          <div className={s.waFoot}>
            <Button onClick={() => setConnecting(true)}>Connect another account</Button>
            <Link href="/instagram/flows" className={s.waLink}>
              Flows
            </Link>
            <Link href="/leads/not-yet" className={s.waLink}>
              Not a lead yet
            </Link>
          </div>
          <section className={s.igOrder} aria-labelledby="ig-order">
            <h3 id="ig-order" className={s.igOrderTitle}>
              Who answers what
            </h3>
            <p className={s.igQuestionNote}>The same order on every account. A person always comes first.</p>
            <ol aria-label="Who answers what">
              {ORDER.map((o, i) => (
                <li key={o.title}>
                  <span className={s.igOrderN} aria-hidden>
                    {i + 1}
                  </span>
                  <span className={s.waChangeText}>
                    <b>{o.title}</b>
                    <small>{o.text}</small>
                  </span>
                </li>
              ))}
            </ol>
            <p className={s.igQuestionNote}>
              Instagram lets a business answer within 24 hours of a person’s last message, and a person (never
              a flow) up to 7 days. Each comment gets one private reply, within 7 days. LUME never writes to
              anyone first.
            </p>
          </section>
        </>
      )}
      {connecting && <ConnectSheet onClose={() => setConnecting(false)} />}
      {leaving && (
        <Dialog label={`Disconnect @${leaving.username}?`} onClose={() => setLeaving(null)}>
          <div className={s.waSheet}>
            <h2 className={s.waSheetTitle}>Disconnect @{leaving.username}?</h2>
            <p className={s.waSheetText}>
              LUME stops getting this account’s messages, and the flows on it stop, saying why. People from it
              waiting in Not a lead yet are cleared. What’s already on leads stays.
            </p>
            <div className={s.waSheetFoot}>
              <Button variant="ghost" onClick={() => setLeaving(null)}>
                Cancel
              </Button>
              <Button variant="danger" loading={leavingBusy} onClick={() => void disconnect(leaving)}>
                Disconnect
              </Button>
            </div>
          </div>
        </Dialog>
      )}
    </article>
  );
}
