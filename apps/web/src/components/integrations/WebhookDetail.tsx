"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { AddWebhookSheet } from "@/components/webhooks/AddWebhookSheet";
import { SecretBox } from "@/components/webhooks/SecretStep";
import { PresetGlyph } from "@/components/webhooks/WhereFromStep";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { shortDateTime } from "@/lib/settings/format";
import { ago } from "@/lib/sheets/format";
import { PRESET_LABEL, REJECTED } from "@/lib/webhooks/format";
import { webhooksClient } from "@/lib/webhooks/client";
import type { WebhookDetail as Detail, WebhookEventView } from "@/lib/webhooks/types";
import s from "./integrations.module.css";

const n = (v: number) => v.toLocaleString("en");

/** What a post did, in words; the lead it made or joined is one tap away. */
function outcome(e: WebhookEventView) {
  if (e.status === "queued") return "Waiting";
  if (e.status === "error") return "A problem (below)";
  if (e.status === "dismissed") return "Set aside";
  const label = e.result === "created" ? "New lead" : e.result === "merged" ? "Joined a lead" : "Skipped";
  return e.leadId ? <Link href={`/leads?lead=${e.leadId}`}>{label}</Link> : label;
}

/** 2C spec §7: is it working, what came in, what needs you — and every action, one tap away. */
export function WebhookDetail({ id }: { id: string }) {
  const router = useRouter();
  const [v, setV] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [rotating, setRotating] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const r = await webhooksClient.get(id);
    if (!r.ok) return setError(r.message);
    setV(r.data);
  }, [id]);
  useEffect(() => void load(), [load]);

  if (error && !v)
    return (
      <p role="alert" className={s.error}>
        {error}
      </p>
    );
  if (!v) return null;

  const act = async (f: () => Promise<{ ok: boolean; message?: string }>) => {
    setBusy(true);
    setError(null);
    const r = await f();
    setBusy(false);
    if (!r.ok) return setError(r.message ?? "Something went wrong.");
    await load();
  };
  const rotate = async () => {
    setBusy(true);
    const r = await webhooksClient.rotate(id);
    setBusy(false);
    if (!r.ok) return setError(r.message);
    setSecret(r.data.secret);
  };
  const draft = v.status === "draft";

  return (
    <div className={s.detail}>
      <Link href="/settings/integrations" className={s.back}>
        <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden>
          <path
            d="M7.5 2.5 4 6l3.5 3.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        Integrations
      </Link>
      <header className={s.detailHead}>
        <PresetGlyph />
        <div>
          <h2 className={s.cardTitle}>{v.name}</h2>
          <p className={s.cardLede}>
            {PRESET_LABEL[v.preset]} · {v.mode === "signed" ? "Signed posts" : "Secret token"}
          </p>
        </div>
      </header>

      {error && (
        <p role="alert" className={s.error}>
          {error}
        </p>
      )}
      {draft && (
        <section className={s.attention} aria-label="Setting up">
          <p>This webhook isn't on yet. Send it a test post, then choose where each field goes.</p>
          <Button variant="primary" onClick={() => setEditing(true)}>
            Finish setting up
          </Button>
        </section>
      )}
      {v.attention && (
        <section className={s.attention} aria-label="Needs attention">
          <p>{v.attention.message}</p>
          <Button variant="primary" onClick={() => setEditing(true)}>
            Open fields
          </Button>
        </section>
      )}
      {v.newColumns.length > 0 && (
        <p className={s.infoLine}>
          {v.newColumns.length === 1
            ? `1 new field seen: ${v.newColumns[0]}.`
            : `${v.newColumns.length} new fields seen: ${v.newColumns.join(", ")}.`}{" "}
          <button type="button" className={s.inlineLink} onClick={() => setEditing(true)}>
            Map {v.newColumns.length === 1 ? "it" : "them"}
          </button>
        </p>
      )}

      <div className={s.share}>
        <span className={s.shareLabel}>Posts go to</span>
        <code className={s.email}>{v.address}</code>
      </div>

      <dl className={s.health}>
        <div>
          <dt>Last post</dt>
          <dd>{v.lastEventAt ? ago(v.lastEventAt) : "None yet"}</dd>
        </div>
        <div>
          <dt>Today</dt>
          <dd>{n(v.eventsToday)}</dd>
        </div>
        <div>
          <dt>All time</dt>
          <dd>{n(v.eventsAllTime)}</dd>
        </div>
        <div>
          <dt>New leads</dt>
          <dd>{n(v.created)}</dd>
        </div>
        <div>
          <dt>Joined a lead</dt>
          <dd>{n(v.merged)}</dd>
        </div>
        <div>
          <dt>Problems</dt>
          <dd>{n(v.problems)}</dd>
        </div>
      </dl>
      {v.rejected > 0 && (
        <p className={s.warnLine}>
          {n(v.rejected)} refused
          {v.lastRejectedReason ? ` · last for ${REJECTED[v.lastRejectedReason]}` : ""}. LUME keeps nothing it
          refuses.
        </p>
      )}

      <div className={s.actions}>
        {!draft && v.status !== "needs_attention" && (
          <Button onClick={() => void act(() => webhooksClient.patch(id, { paused: v.status === "active" }))}>
            {v.status === "paused" ? "Resume" : "Pause"}
          </Button>
        )}
        {!draft && <Button onClick={() => setEditing(true)}>Edit fields and rules</Button>}
        <Button onClick={() => setRotating(true)}>New secret</Button>
        <Button
          variant="ghost"
          className={s.danger}
          aria-label="Remove webhook"
          onClick={() => setRemoving(true)}
        >
          Remove
        </Button>
      </div>
      {v.runAs && <p className={s.cardLede}>Runs as {v.runAs.name}, who last saved its fields.</p>}

      {v.events.length > 0 && (
        <section aria-labelledby="posts-title">
          <h3 id="posts-title" className={s.sectionTitle}>
            Recent posts
          </h3>
          <table className={s.table} aria-label="Recent posts">
            <thead>
              <tr>
                <th scope="col">When</th>
                <th scope="col">What happened</th>
              </tr>
            </thead>
            <tbody>
              {v.events.map((e) => (
                <tr key={e.id}>
                  <td>{shortDateTime(e.receivedAt)}</td>
                  <td>{outcome(e)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {v.problemEvents.length > 0 && (
        <section aria-labelledby="problems-title">
          <h3 id="problems-title" className={s.sectionTitle}>
            Problem posts
          </h3>
          <p className={s.cardLede}>
            Change the fields or rules, then Retry. A post you don't need, dismiss.
          </p>
          <ul className={s.problems}>
            {v.problemEvents.map((p) => (
              <li key={p.id}>
                <span className={s.rowNo}>{shortDateTime(p.receivedAt)}</span>
                <span>{p.problems.map((x) => x.message).join(" ")}</span>
                <span>
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`Retry post ${p.id}`}
                    onClick={() => void act(() => webhooksClient.retry(id, p.id))}
                  >
                    Retry
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`Dismiss post ${p.id}`}
                    onClick={() => void act(() => webhooksClient.dismiss(id, p.id))}
                  >
                    Dismiss
                  </Button>
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <AddWebhookSheet
        open={editing}
        manychat={false}
        sourceId={id}
        finishing={draft}
        onClose={() => {
          setEditing(false);
          void load();
        }}
      />
      {rotating && (
        <Dialog
          label="Give it a new secret?"
          onClose={() => {
            setRotating(false);
            setSecret(null);
          }}
        >
          <h3 className={s.sectionTitle}>{secret ? "The new secret" : "Give it a new secret?"}</h3>
          {secret ? (
            <>
              <SecretBox secret={secret} />
              <div className={s.actions}>
                <Button
                  variant="primary"
                  onClick={() => {
                    setRotating(false);
                    setSecret(null);
                  }}
                >
                  Done
                </Button>
              </div>
            </>
          ) : (
            <>
              <p className={s.cardLede}>
                The old secret stops working at once. Put the new one wherever “{v.name}” posts from.
              </p>
              <div className={s.actions}>
                <Button variant="ghost" onClick={() => setRotating(false)}>
                  Keep the old one
                </Button>
                <Button variant="primary" loading={busy} onClick={() => void rotate()}>
                  New secret
                </Button>
              </div>
            </>
          )}
        </Dialog>
      )}
      {removing && (
        <Dialog label="Remove this webhook?" onClose={() => setRemoving(false)}>
          <h3 className={s.sectionTitle}>Remove this webhook?</h3>
          <p className={s.cardLede}>Its leads stay in LUME. Posts to its address will be refused.</p>
          <div className={s.actions}>
            <Button variant="ghost" onClick={() => setRemoving(false)}>
              Keep it
            </Button>
            <Button
              variant="danger"
              onClick={async () => {
                const r = await webhooksClient.remove(id);
                if (r.ok) router.push("/settings/integrations");
              }}
            >
              Remove
            </Button>
          </div>
        </Dialog>
      )}
    </div>
  );
}
