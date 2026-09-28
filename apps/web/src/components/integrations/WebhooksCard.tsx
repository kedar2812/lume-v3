"use client";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { AddWebhookSheet } from "@/components/webhooks/AddWebhookSheet";
import { PresetGlyph } from "@/components/webhooks/WhereFromStep";
import { Button } from "@/components/ui/Button";
import { Switch } from "@/components/ui/Switch";
import type { IntegrationsView } from "@/lib/sheets/types";
import { webhookHealth } from "@/lib/webhooks/format";
import { webhooksClient } from "@/lib/webhooks/client";
import type { WebhookStatus, WebhookView } from "@/lib/webhooks/types";
import s from "./integrations.module.css";

const STATUS: Record<WebhookStatus, string> = {
  draft: "Setting up",
  active: "Active",
  paused: "Paused",
  needs_attention: "Needs attention",
};

/** 2C spec §6: webhooks as one more optional module — a switch, the webhooks, and a way to add one. */
export function WebhooksCard({
  webhooks,
  onView,
}: {
  webhooks: IntegrationsView["webhooks"];
  onView(v: IntegrationsView): void;
}) {
  const [sources, setSources] = useState<WebhookView[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const r = await webhooksClient.list();
    if (r.ok) setSources(r.data.sources);
  }, []);
  useEffect(() => {
    if (webhooks.enabled) void load();
  }, [webhooks.enabled, load]);

  const toggle = async (enabled: boolean) => {
    setError(null);
    const r = await webhooksClient.setEnabled(enabled);
    if (!r.ok) return setError(r.message);
    onView(r.data);
  };

  return (
    <article className={s.card} aria-labelledby="wh-title">
      <header className={s.cardHead}>
        <PresetGlyph />
        <div className={s.cardText}>
          <h2 id="wh-title" className={s.cardTitle}>
            Webhooks
          </h2>
          <p className={s.cardLede}>
            Your website form, Zapier or Make post each new enquiry to LUME, and it's a lead in a second.
          </p>
        </div>
        <Switch checked={webhooks.enabled} onChange={(v) => void toggle(v)} label="Webhooks" labelHidden />
      </header>
      {error && (
        <p role="alert" className={s.error}>
          {error}
        </p>
      )}
      {webhooks.enabled && (
        <>
          {sources &&
            (sources.length ? (
              <ul className={s.sources}>
                {sources.map((v) => (
                  <li key={v.id}>
                    <Link href={`/settings/integrations/webhooks/${v.id}`} className={s.source}>
                      <span className={s.sourceName}>{v.name}</span>
                      <span className={s.sourceMeta}>{webhookHealth(v)}</span>
                      <span className={s.pill} data-status={v.status}>
                        {STATUS[v.status]}
                      </span>
                      <svg className={s.chev} viewBox="0 0 12 12" width="12" height="12" aria-hidden>
                        <path
                          d="M4.5 2.5 8 6l-3.5 3.5"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.6"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <p className={s.empty}>No webhooks yet. Add one, and every post to it becomes a lead.</p>
            ))}
          <div className={s.cardFoot}>
            <Button variant="primary" onClick={() => setAdding(true)}>
              Add a webhook
            </Button>
          </div>
        </>
      )}
      <AddWebhookSheet
        open={adding}
        manychat={webhooks.manychat}
        onClose={() => {
          setAdding(false);
          void load();
        }}
      />
    </article>
  );
}
