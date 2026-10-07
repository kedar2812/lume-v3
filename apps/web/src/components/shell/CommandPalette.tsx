"use client";
import { initialsOf } from "@lume/core/shared";
import { AnimatePresence, motion } from "motion/react";
import { Dialog } from "radix-ui";
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { leadsClient } from "@/lib/leads/client";
import { OPEN_NOTIFICATIONS } from "@/lib/notifications/client";
import type { Lead } from "@/lib/leads/types";
import { SPRINGS, toMotion } from "@/lib/motion";
import { fuzzyRank } from "@/lib/search/fuzzy";
import { SETTINGS_AREAS } from "@/lib/settings/areas";
import { settingsHits } from "@/lib/settings/index";
import { templatesClient } from "@/lib/templates/client";
import { themeCookie, type ThemePref } from "@/lib/theme";
import { viewsClient } from "@/lib/views/client";
import { NavIcon } from "./icons";
import { NAV_ITEMS, visibleNav } from "./nav";
import { usePageNav } from "./PageTransition";
import s from "./palette.module.css";

type Props = { open: boolean; onOpenChange(v: boolean): void; can(p: string): boolean };
type Group = "Recent" | "Leads" | "Actions" | "Go to" | "Views" | "Settings" | "Templates";
type Item = {
  id: string;
  group: Group;
  label: string;
  hint?: string;
  keywords?: string[];
  icon: ReactNode;
  kbd?: string;
  run(): void;
};

const RECENT_KEY = "lume:recent-leads";
const RECENT_MAX = 5;
/** Leads are looked up once typing pauses this long; a search slower than SLOW_MS says it's looking. */
const PAUSE_MS = 140;
const SLOW_MS = 250;
const PER_GROUP = 5;
const ORDER: Group[] = ["Recent", "Leads", "Actions", "Go to", "Views", "Settings", "Templates"];

type Recent = { id: string; name: string; hint?: string };
function readRecent(): Recent[] {
  try {
    return (JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]") as Recent[]).slice(0, RECENT_MAX);
  } catch {
    return [];
  }
}
function remember(r: Recent) {
  try {
    const next = [r, ...readRecent().filter((x) => x.id !== r.id)].slice(0, RECENT_MAX);
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    // no storage: nothing to remember
  }
}

const Glyph = ({ d }: { d: string }) => (
  <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden className={s.glyph}>
    <path d={d} />
  </svg>
);
const G = {
  plus: "M12 5v14M5 12h14",
  upload: "M12 16V4M7 9l5-5 5 5M4 20h16",
  bell: "M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0",
  sun: "M12 3v2M12 19v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M3 12h2M19 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8",
  moon: "M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z",
  auto: "M12 3a9 9 0 1 0 0 18V3z",
  view: "M3 6h18M7 12h10M10 18h4",
  gear: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z",
  doc: "M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9zM14 3v6h6M8 13h8M8 17h5",
};
const initials = initialsOf;

/**
 * Search LUME (Ctrl K; owner, 2026-10-05, replacing the Phase 0 stand-in): leads by name, phone number or email, as you
 * type; things to do (a new lead, an import, the theme, notifications); every page, saved view, setting and template,
 * found by a few letters even with a typo. Empty, it offers the leads you opened last. ↑↓ and Enter, all by keyboard.
 */
export function CommandPalette({ open, onOpenChange, can }: Props) {
  const [query, setQuery] = useState("");
  const [sel, setSel] = useState(0);
  const [leads, setLeads] = useState<Lead[]>([]);
  const [looking, setLooking] = useState(false);
  const [slow, setSlow] = useState(false);
  const [failed, setFailed] = useState(false);
  const [recent, setRecent] = useState<Recent[]>([]);
  const [views, setViews] = useState<{ id: string; name: string }[]>([]);
  const [templates, setTemplates] = useState<{ id: string; name: string; category: string }[]>([]);
  const { go } = usePageNav();
  const listId = useId();
  const asked = useRef(0);
  const q = query.trim();

  const close = () => {
    onOpenChange(false);
    setQuery("");
    setSel(0);
  };
  const theme = (v: ThemePref) => {
    document.documentElement.dataset.theme = v;
    document.cookie = themeCookie(v);
  };

  // What's worth having at hand, read once each time it opens.
  useEffect(() => {
    if (!open) return;
    setRecent(readRecent());
    if (can("leads.view"))
      void viewsClient
        .list()
        .then((r) => r.ok && setViews(r.data.views.map((v) => ({ id: v.id, name: v.name }))));
    if (can("templates.use"))
      void templatesClient
        .list()
        .then(
          (r) =>
            r.ok &&
            setTemplates(r.data.templates.map((t) => ({ id: t.id, name: t.name, category: t.category }))),
        );
  }, [open, can]);

  // Leads, from the server, once typing pauses; an older answer never replaces a newer one.
  useEffect(() => {
    if (!open || !can("leads.view") || q.length < 2) {
      setLeads([]);
      setLooking(false);
      setSlow(false);
      setFailed(false);
      return;
    }
    const n = ++asked.current;
    setLooking(true);
    setFailed(false);
    const slowT = setTimeout(() => n === asked.current && setSlow(true), PAUSE_MS + SLOW_MS);
    const t = setTimeout(() => {
      void leadsClient.list({ q, stageIds: [], sort: "newest" }, undefined, 6).then((r) => {
        if (n !== asked.current) return;
        setLooking(false);
        setSlow(false);
        if (r.ok) setLeads(r.data.items);
        else {
          setLeads([]);
          setFailed(true);
        }
      });
    }, PAUSE_MS);
    return () => {
      clearTimeout(t);
      clearTimeout(slowT);
    };
  }, [q, open, can]);

  const local = useMemo<Item[]>(() => {
    const out: Item[] = [];
    if (can("leads.create"))
      out.push({
        id: "a:new",
        group: "Actions",
        label: "New lead",
        keywords: ["add", "create", "lead"],
        icon: <Glyph d={G.plus} />,
        kbd: "N",
        run: () => go("/leads?do=new"),
      });
    if (can("leads.import"))
      out.push({
        id: "a:import",
        group: "Actions",
        label: "Import leads",
        keywords: ["csv", "excel", "upload", "file"],
        icon: <Glyph d={G.upload} />,
        run: () => go("/leads?do=import"),
      });
    out.push(
      {
        id: "a:notes",
        group: "Actions",
        label: "Open notifications",
        keywords: ["bell", "alerts", "unread"],
        icon: <Glyph d={G.bell} />,
        kbd: ".",
        run: () => window.dispatchEvent(new Event(OPEN_NOTIFICATIONS)),
      },
      {
        id: "a:obsidian",
        group: "Actions",
        label: "Theme: Obsidian",
        keywords: ["dark", "night", "theme", "appearance"],
        icon: <Glyph d={G.moon} />,
        run: () => theme("obsidian"),
      },
      {
        id: "a:porcelain",
        group: "Actions",
        label: "Theme: Porcelain",
        keywords: ["light", "day", "theme", "appearance"],
        icon: <Glyph d={G.sun} />,
        run: () => theme("porcelain"),
      },
      {
        id: "a:auto",
        group: "Actions",
        label: "Theme: Auto",
        keywords: ["system", "theme", "appearance"],
        icon: <Glyph d={G.auto} />,
        run: () => theme("system"),
      },
    );
    for (const i of visibleNav(NAV_ITEMS, can))
      out.push({
        id: `p:${i.id}`,
        group: "Go to",
        label: i.label,
        keywords: ["go to", "open", "page"],
        icon: <NavIcon name={i.icon} />,
        run: () => go(i.href),
      });
    for (const v of views)
      out.push({
        id: `v:${v.id}`,
        group: "Views",
        label: v.name,
        hint: "Saved view",
        keywords: ["view", "list", "filter"],
        icon: <Glyph d={G.view} />,
        run: () => go(`/leads?view=${v.id}`),
      });
    const areas = SETTINGS_AREAS.filter((a) => a.anyOf.some((k) => k === "auth.self" || can(k)));
    for (const h of settingsHits(areas))
      out.push({
        id: `s:${h.id}`,
        group: "Settings",
        label: h.label,
        hint: h.where,
        keywords: ["settings", ...h.keywords],
        icon: <Glyph d={G.gear} />,
        run: () => {
          try {
            if (h.kind !== "area") sessionStorage.setItem("lume:settings:find", h.label);
          } catch {
            // no storage: the page opens without the glow
          }
          go(h.href);
        },
      });
    for (const t of templates)
      out.push({
        id: `t:${t.id}`,
        group: "Templates",
        label: t.name,
        hint: "Template",
        keywords: ["template", "message", "whatsapp", t.category.replace(/_/g, " ")],
        icon: <Glyph d={G.doc} />,
        run: () => go("/templates"),
      });
    return out;
  }, [can, views, templates, go]);

  const items = useMemo<Item[]>(() => {
    const leadItems: Item[] = leads.map((l) => {
      const name = l.name ?? "A lead";
      const hint = l.phone?.display ?? l.email?.display ?? undefined;
      return {
        id: `l:${l.id}`,
        group: "Leads",
        label: name,
        ...(hint ? { hint } : {}),
        icon: <span className={s.ini}>{initials(name)}</span>,
        run: () => {
          remember({ id: l.id, name, ...(hint ? { hint } : {}) });
          go(`/leads?lead=${l.id}`);
        },
      };
    });
    if (!q) {
      // Nothing typed: the leads you opened last, the things to do, and the pages.
      const rec: Item[] = recent.map((r) => ({
        id: `r:${r.id}`,
        group: "Recent",
        label: r.name,
        ...(r.hint ? { hint: r.hint } : {}),
        icon: <span className={s.ini}>{initials(r.name)}</span>,
        run: () => {
          remember(r);
          go(`/leads?lead=${r.id}`);
        },
      }));
      return [
        ...rec,
        ...local.filter((i) => i.group === "Actions").slice(0, 3),
        ...local.filter((i) => i.group === "Go to"),
      ];
    }
    const ranked = fuzzyRank(q, local, (i) => ({
      label: i.label,
      keywords: [...(i.keywords ?? []), i.hint ?? ""],
    }));
    const byGroup = new Map<Group, Item[]>();
    for (const i of ranked) {
      const g = byGroup.get(i.group) ?? [];
      if (g.length < PER_GROUP) g.push(i);
      byGroup.set(i.group, g);
    }
    byGroup.set("Leads", leadItems);
    return ORDER.flatMap((g) => byGroup.get(g) ?? []);
  }, [q, local, leads, recent]);

  useEffect(() => setSel((v) => Math.min(v, Math.max(0, items.length - 1))), [items.length]);

  function run(i: number) {
    const it = items[i];
    if (!it) return;
    close();
    it.run();
  }
  function onKey(e: KeyboardEvent) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const n = items.length || 1;
      setSel((v) => (v + (e.key === "ArrowDown" ? 1 : -1) + n) % n);
    } else if (e.key === "Enter") {
      e.preventDefault();
      run(sel);
    }
  }

  const groups = ORDER.map((g) => ({ g, list: items.filter((i) => i.group === g) })).filter(
    (x) => x.list.length,
  );
  const searchingLeads = q.length >= 2 && can("leads.view");
  const nothing = !items.length && !(looking && slow);

  return (
    <Dialog.Root open={open} onOpenChange={(v) => (v ? onOpenChange(true) : close())}>
      <AnimatePresence>
        {open && (
          <Dialog.Portal forceMount>
            <Dialog.Overlay asChild forceMount>
              <motion.div
                className={s.overlay}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
              />
            </Dialog.Overlay>
            <Dialog.Content asChild forceMount aria-describedby={undefined} onKeyDown={onKey}>
              <motion.div
                className={s.panel}
                initial={{ opacity: 0, scale: 0.96, y: -6, filter: "blur(6px)", x: "-50%" }}
                animate={{ opacity: 1, scale: 1, y: 0, filter: "blur(0px)", x: "-50%" }}
                exit={{ opacity: 0, scale: 0.97, y: -4, x: "-50%", transition: { duration: 0.15 } }}
                transition={toMotion(SPRINGS.default)}
              >
                <Dialog.Title className={s.srOnly}>Search LUME</Dialog.Title>
                <div className={s.inputRow}>
                  <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden className={s.lens}>
                    <circle cx="11" cy="11" r="7" />
                    <path d="m20 20-3.5-3.5" />
                  </svg>
                  <input
                    className={s.input}
                    role="combobox"
                    aria-label="Search leads, pages, settings and actions"
                    aria-expanded
                    aria-controls={listId}
                    aria-activedescendant={items[sel] ? `${listId}-${sel}` : undefined}
                    placeholder="Search leads by name, phone or email — or type a page, setting or action"
                    value={query}
                    autoFocus
                    onChange={(e) => {
                      setQuery(e.target.value);
                      setSel(0);
                    }}
                  />
                  {looking && slow && <i className={s.spinner} aria-hidden />}
                </div>
                <div className={s.list} role="listbox" id={listId} aria-label="Results">
                  {groups.map(({ g, list }) => (
                    <div key={g} role="group" aria-label={g}>
                      <div className={s.group} aria-hidden>
                        {g === "Recent" ? "Opened lately" : g}
                      </div>
                      {list.map((it) => {
                        const i = items.indexOf(it);
                        return (
                          <div
                            key={it.id}
                            id={`${listId}-${i}`}
                            role="option"
                            aria-selected={i === sel}
                            className={s.option}
                            onMouseMove={() => sel !== i && setSel(i)}
                            onClick={() => run(i)}
                          >
                            {it.icon}
                            <span className={s.label}>
                              <Marked text={it.label} query={query} />
                            </span>
                            {it.hint && <span className={s.hint}>{it.hint}</span>}
                            {it.kbd && <kbd className={s.kbd}>{it.kbd}</kbd>}
                          </div>
                        );
                      })}
                    </div>
                  ))}
                  {searchingLeads && looking && slow && !leads.length && (
                    <div className={s.wait} role="status">
                      Looking through your leads…
                    </div>
                  )}
                  {searchingLeads && failed && (
                    <div className={s.empty} role="status">
                      LUME couldn&apos;t search your leads just now. Try again in a moment.
                    </div>
                  )}
                  {nothing && q && !failed && (
                    <div className={s.empty} role="status">
                      Nothing matches “{q}”.{" "}
                      {can("leads.view") ? "Leads are found by name, phone number or email." : ""}
                    </div>
                  )}
                </div>
                <div className={s.foot}>
                  <span>↑↓ to move</span>
                  <span>↵ to open</span>
                  <span>esc to close</span>
                </div>
              </motion.div>
            </Dialog.Content>
          </Dialog.Portal>
        )}
      </AnimatePresence>
    </Dialog.Root>
  );
}

/** The typed words, marked where they appear in a result (canvas Phase 7, Search): you see why it matched. */
export function Marked({ text, query }: { text: string; query: string }) {
  const q = query.trim();
  if (q.length < 2) return <>{text}</>;
  const at = text.toLowerCase().indexOf(q.toLowerCase());
  if (at < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, at)}
      <mark className={s.mark}>{text.slice(at, at + q.length)}</mark>
      {text.slice(at + q.length)}
    </>
  );
}
