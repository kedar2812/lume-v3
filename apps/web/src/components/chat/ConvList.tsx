"use client";
import { unreadSum } from "@lume/core/shared";
import { Avatar } from "@/components/ui/Avatar";
import { lookOf } from "@/lib/avatar/look";
import type { ChatList, ConvRow, ListKey } from "@/lib/chat/client";
import s from "./chat.module.css";

/** A conversation's name as the list says it: #channel, the people in a direct message, or the lead's name. */
export function convName(c: ConvRow): string {
  if (c.kind === "channel") return c.name ?? "";
  if (c.kind === "lead") return c.lead?.name.trim() || "Lead with no name";
  return (c.people ?? []).map((p) => p.name).join(", ") || "Just you";
}

const LISTS: { key: ListKey; title: string; none: string }[] = [
  { key: "channels", title: "Channels", none: "You're not in a channel yet. An admin can add you." },
  { key: "direct", title: "Direct messages", none: "No direct messages yet." },
  { key: "leads", title: "Lead threads", none: "A lead's thread starts when someone writes about the lead." },
];

/**
 * The conversations (owner, 2026-11-24): channels the person is in, their direct messages and lead threads, each a list
 * that folds under its heading; a folded list shows the sum of its unread on the heading, 99+ past 99.
 */
export function ConvList({
  list,
  openId,
  online,
  onOpen,
  onFold,
  onNewDirect,
  onChannels,
}: {
  list: ChatList;
  openId: string | null;
  online: ReadonlySet<string>;
  onOpen: (id: string) => void;
  onFold: (key: ListKey, folded: boolean) => void;
  onNewDirect?: () => void;
  /** For whoever manages channels. */
  onChannels?: () => void;
}) {
  const adds: Partial<Record<ListKey, { label: string; go: () => void }>> = {
    ...(onChannels ? { channels: { label: "Manage channels", go: onChannels } } : {}),
    ...(onNewDirect ? { direct: { label: "New direct message", go: onNewDirect } } : {}),
  };
  return (
    <nav className={s.clist} aria-label="Conversations">
      <div className={s.cscroll}>
        {LISTS.map(({ key, title, none }) => {
          const rows = list[key];
          const shut = list.folds[key];
          // The open conversation's count is being read: it isn't waiting.
          const counts = rows.map((r) => (r.id === openId || r.muted ? 0 : r.unread));
          const sum = unreadSum(counts);
          return (
            <section key={key} aria-label={title}>
              <div className={s.csec}>
                <button
                  type="button"
                  className={s.cfold}
                  aria-expanded={!shut}
                  onClick={() => onFold(key, !shut)}
                >
                  <svg
                    className={s.chev}
                    data-open={!shut || undefined}
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.4"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden
                  >
                    <path d="m9 6 6 6-6 6" />
                  </svg>
                  <span className={s.ctl}>{title}</span>
                  {shut && sum && (
                    <span className={s.un} aria-label={`${sum} unread in ${title}`}>
                      {sum}
                    </span>
                  )}
                </button>
                {adds[key] && (
                  <button
                    type="button"
                    className={s.tbtn}
                    aria-label={adds[key].label}
                    title={adds[key].label}
                    onClick={adds[key].go}
                  >
                    +
                  </button>
                )}
              </div>
              <div className={s.cgrp} data-shut={shut || undefined} inert={shut || undefined}>
                <div className={s.cgin}>
                  {rows.length === 0 && <p className={s.cnone}>{none}</p>}
                  {rows.map((c) => {
                    const n = c.id === openId || c.muted ? 0 : c.unread;
                    const other = c.kind === "direct" && c.people?.length === 1 ? c.people[0] : undefined;
                    return (
                      <button
                        key={c.id}
                        type="button"
                        className={s.crow}
                        aria-current={c.id === openId ? "page" : undefined}
                        data-unread={n > 0 || undefined}
                        onClick={() => onOpen(c.id)}
                      >
                        {c.kind === "channel" && (
                          <span className={s.hash} aria-hidden>
                            #
                          </span>
                        )}
                        {c.kind === "direct" && (
                          <span className={s.avw}>
                            <Avatar
                              name={other?.name ?? convName(c)}
                              size={22}
                              {...(other ? lookOf(other.id, other.avatar) : {})}
                            />
                            {other && (
                              <i
                                className={s.dot}
                                data-on={online.has(other.id) || undefined}
                                role="img"
                                aria-label={online.has(other.id) ? "Online" : "Offline"}
                              />
                            )}
                          </span>
                        )}
                        {c.kind === "lead" && <Avatar name={convName(c)} size={22} />}
                        <span className={s.cn}>{convName(c)}</span>
                        {c.kind === "lead" && c.lead?.stage && (
                          <span className={s.stage}>{c.lead.stage}</span>
                        )}
                        {n > 0 && <span className={s.un}>{n > 99 ? "99+" : n}</span>}
                      </button>
                    );
                  })}
                </div>
              </div>
            </section>
          );
        })}
      </div>
    </nav>
  );
}
