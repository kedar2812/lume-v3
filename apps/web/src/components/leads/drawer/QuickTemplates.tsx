"use client";
import { render, type RenderContext } from "@lume/core/shared";
import Link from "next/link";
import { useEffect, useState } from "react";
import { Popover } from "@/components/ui/Popover";
import { templatesClient, type TemplateView } from "@/lib/templates/client";
import s from "./whatsapp.module.css";

/**
 * A reply from the business's own templates, in this lead's words (owner 2026-11-02): one tap puts it in the box, to
 * send as it is or change first. Inside WhatsApp's 24 hours it's an ordinary message: no LUME AI and nothing to pay.
 */
export function QuickTemplates({
  leadId,
  onPick,
  disabled = false,
}: {
  leadId: string;
  onPick(text: string): void;
  disabled?: boolean;
}) {
  return (
    <Popover
      label="Templates"
      side="above"
      role="menu"
      triggerLabel="Templates"
      triggerClassName={s.attachButton}
      trigger={<Lines />}
      disabled={disabled}
    >
      {(close) => (
        <List
          leadId={leadId}
          onPick={(text) => {
            close();
            onPick(text);
          }}
        />
      )}
    </Popover>
  );
}

/** Fetched as the menu opens: the templates, and this lead's words to fill them with. */
function List({ leadId, onPick }: { leadId: string; onPick(text: string): void }) {
  const [templates, setTemplates] = useState<TemplateView[] | null>(null);
  const [ctx, setCtx] = useState<RenderContext | null>(null);
  useEffect(() => {
    let live = true;
    void Promise.all([templatesClient.list(), templatesClient.context(leadId)]).then(([l, c]) => {
      if (!live) return;
      setTemplates(l.ok ? l.data.templates : []);
      if (c.ok) setCtx(c.data);
    });
    return () => {
      live = false;
    };
  }, [leadId]);

  if (templates === null)
    return (
      <p className={s.quickEmpty} role="status">
        Loading templates…
      </p>
    );
  if (!templates.length)
    return (
      <p className={s.quickEmpty}>
        No templates yet. Make them in <Link href="/templates">Templates</Link>.
      </p>
    );
  return (
    <div className={s.quickList}>
      {templates.map((t) => {
        const text = ctx ? render(t.body, ctx).text : t.body;
        return (
          <button
            key={t.id}
            type="button"
            role="menuitem"
            className={s.quickItem}
            onClick={() => onPick(text)}
          >
            <b>{t.name}</b>
            <span>{text}</span>
          </button>
        );
      })}
    </div>
  );
}

function Lines() {
  return (
    <svg
      aria-hidden="true"
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
    >
      <path d="M4 6h16M4 12h10M4 18h13" />
    </svg>
  );
}
