"use client";
import { useCallback, useRef, useState } from "react";
import { storageCount, storageSize, type CleanKind } from "@lume/core/shared";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/feedback/ToastProvider";
import { SettingsPage } from "@/components/settings/SettingsPage";
import { storageClient, type Storage, type StorageKind } from "@/lib/settings/storage";
import { CLEAN_WORDS, CleanUpSheet, DEFAULT_TICKS } from "./CleanUpSheet";
import { CleanUpMorph, type CleanUpHandle } from "./CleanUpMorph";
import { KEEP_CHOICES, useKeepChoice } from "@/components/integrations/WhatsAppKeep";
import s from "./storage.module.css";

const KIND_WORDS: Record<StorageKind, { name: string; what: string; cls: string }> = {
  whatsapp: {
    name: "WhatsApp files",
    what: "Photos, voice notes, videos and documents in chats",
    cls: s.k1!,
  },
  instagram: {
    name: "Instagram files",
    what: "What people sent in DMs, and their profile photos",
    cls: s.k2!,
  },
  previews: { name: "Previews", what: "Thumbnails and page pictures, so files open fast", cls: s.k3! },
  library: { name: "File library", what: "Files your team sends again and again", cls: s.k3! },
  database: {
    name: "Leads and messages",
    what: "Every lead, note and task, and the words of every message",
    cls: s.k4!,
  },
};

/**
 * Settings › Storage (approved canvas Xfjnt1veeiGTAiPhQTpbr7): the disk in one line and one bar, what LUME can give
 * back, what's here, and what LUME does on its own. Clean up opens the sheet; Clear runs the morph; the numbers are
 * read again when it lands.
 */
export function StoragePage({ initial }: { initial: Storage }) {
  const [data, setData] = useState(initial);
  const [sheet, setSheet] = useState(false);
  const morph = useRef<CleanUpHandle>(null);
  const { toast } = useToast();

  const reload = useCallback(async () => {
    const r = await storageClient.get();
    if (r.ok) setData(r.data);
  }, []);
  const lume = data.kinds.reduce((a, k) => a + k.bytes, 0);
  const total = data.disk?.total ?? 0;
  const used = data.disk ? data.disk.total - data.disk.free : lume;
  const usedShare = total ? used / total : 0;
  const full = data.disk ? Math.round(usedShare * 100) >= data.settings.warnAtPct : false;
  const tips = data.candidates.filter((c) => DEFAULT_TICKS.includes(c.kind) && c.bytes > 0);
  const tipBytes = tips.reduce((a, c) => a + c.bytes, 0);
  const pct = (b: number) => (total ? `${(b / total) * 100}%` : "0%");
  const kind = (k: StorageKind) => data.kinds.find((x) => x.key === k)?.bytes ?? 0;
  const segments = [
    { cls: s.k1, w: kind("whatsapp") },
    { cls: s.k2, w: kind("instagram") },
    { cls: s.k3, w: kind("previews") + kind("library") },
    { cls: s.k4, w: kind("database") },
    { cls: s.k5, w: data.other ?? 0 },
  ];
  const save = async (patch: Partial<Storage["settings"]>) => {
    const r = await storageClient.settings(patch);
    if (!r.ok) return toast({ tone: "danger", title: "Not saved", detail: r.message });
    setData((d) => ({ ...d, settings: r.data.settings }));
    toast({ tone: "ok", title: "Saved" });
  };
  // The keep-for is the WhatsApp card's own choice (one setting for every chat): a shorter one asks first, the same way.
  const keep = useKeepChoice({
    months: data.settings.keepFilesMonths,
    save: async (to) => {
      const r = await storageClient.settings({ keepFilesMonths: to });
      if (r.ok) setData((d) => ({ ...d, settings: r.data.settings }));
      return r.ok ? { ok: true } : { ok: false, message: r.message };
    },
  });

  return (
    <SettingsPage
      title="Storage"
      description="What LUME keeps on this server, and the room it can give back."
      actions={
        <CleanUpMorph
          ref={morph}
          usedShare={usedShare}
          diskTotal={data.disk?.total ?? null}
          running={data.running}
          onOpen={() => setSheet(true)}
          onLanded={() => void reload()}
        />
      }
    >
      <div className={s.page} data-storage="">
        <div className={s.disk}>
          <div className={s.line}>
            <span className={s.used}>{storageSize(used)}</span>
            <span className={s.of}>{data.disk ? `of ${storageSize(total)} used` : "kept by LUME"}</span>
            <span className={s.pill} data-full={full || undefined}>
              {full ? "Getting full" : "Plenty of room"}
            </span>
          </div>
          {data.disk ? (
            <>
              <div
                className={s.bar}
                role="img"
                aria-label={`${storageSize(used)} of ${storageSize(total)} used`}
              >
                {segments.map((g, i) => (
                  <i key={i} className={g.cls} style={{ width: pct(g.w) }} />
                ))}
              </div>
              <div className={s.keys}>
                <span>
                  <i className={s.k1} />
                  WhatsApp files
                </span>
                <span>
                  <i className={s.k2} />
                  Instagram files
                </span>
                <span>
                  <i className={s.k3} />
                  Previews and the file library
                </span>
                <span>
                  <i className={s.k4} />
                  Leads and messages
                </span>
                <span>
                  <i className={s.k5} />
                  The rest of the server
                </span>
              </div>
            </>
          ) : (
            <p className={s.unread}>
              LUME can&apos;t read this disk&apos;s size, so it shows only what LUME keeps.
            </p>
          )}
        </div>

        {tipBytes > 0 && (
          <section className={s.group} aria-labelledby="st-give">
            <div className={s.head}>
              <h2 id="st-give">LUME can give back {storageSize(tipBytes)}</h2>
              <p>Nothing on a lead you&apos;re still working.</p>
            </div>
            {tips.map((c) => (
              <div key={c.kind} className={s.row}>
                <div className={s.words}>
                  <b title={CLEAN_WORDS[c.kind].name}>{CLEAN_WORDS[c.kind].name}</b>
                  <span>{CLEAN_WORDS[c.kind].what}</span>
                </div>
                <b className={s.size}>{storageSize(c.bytes)}</b>
              </div>
            ))}
            <div className={s.foot}>
              <Button onClick={() => setSheet(true)}>Choose what to clear</Button>
            </div>
          </section>
        )}

        <section className={s.group} aria-labelledby="st-here">
          <div className={s.head}>
            <h2 id="st-here">What&apos;s here</h2>
          </div>
          {data.kinds.map((k) => (
            <div key={k.key} className={s.row}>
              <i className={`${s.dot} ${KIND_WORDS[k.key].cls}`} aria-hidden />
              <div className={s.words}>
                <b>{KIND_WORDS[k.key].name}</b>
                <span>
                  {KIND_WORDS[k.key].what}
                  {k.files > 0 && ` · ${storageCount(k.files)} ${k.files === 1 ? "file" : "files"}`}
                </span>
              </div>
              <b className={s.size}>{storageSize(k.bytes)}</b>
            </div>
          ))}
          {data.other !== null && (
            <div className={s.row}>
              <i className={`${s.dot} ${s.k5}`} aria-hidden />
              <div className={s.words}>
                <b>The rest of the server</b>
                <span>The system and other apps. LUME doesn&apos;t touch these.</span>
              </div>
              <b className={s.size}>{storageSize(data.other)}</b>
            </div>
          )}
        </section>

        <section className={s.group} aria-labelledby="st-own">
          <div className={s.head}>
            <h2 id="st-own">On its own</h2>
            <p>LUME already clears files nothing points to, every hour.</p>
          </div>
          <label className={s.row}>
            <span className={s.words}>
              <b>Keep chat files for</b>
              <span>
                WhatsApp and Instagram files past this are cleared within the hour. Each message says so, and
                the file stays on the phone or in Instagram.
              </span>
            </span>
            <select
              className={s.select}
              value={data.settings.keepFilesMonths ? String(data.settings.keepFilesMonths) : ""}
              disabled={keep.busy}
              onChange={(e) => void keep.choose(e.target.value)}
            >
              {KEEP_CHOICES.map((o) => (
                <option key={o.label} value={o.value ?? ""}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          {keep.error && (
            <p role="alert" className={s.error}>
              {keep.error}
            </p>
          )}
          {keep.dialog}
          <label className={s.row}>
            <span className={s.words}>
              <b>Tell admins when the disk passes</b>
              <span>A notification, with what LUME can give back.</span>
            </span>
            <select
              className={s.select}
              value={String(data.settings.warnAtPct)}
              onChange={(e) => void save({ warnAtPct: Number(e.target.value) as 70 | 80 | 90 })}
            >
              {[70, 80, 90].map((n) => (
                <option key={n} value={n}>
                  {n}%
                </option>
              ))}
            </select>
          </label>
        </section>

        {sheet && (
          <CleanUpSheet
            candidates={data.candidates}
            onClose={() => setSheet(false)}
            onClear={(kinds: CleanKind[]) => {
              setSheet(false);
              morph.current?.clear(kinds);
            }}
          />
        )}
      </div>
    </SettingsPage>
  );
}
