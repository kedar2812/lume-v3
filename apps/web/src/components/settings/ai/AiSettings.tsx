"use client";
import { profileProblem, type AiProfile, type AiProfilePatch } from "@lume/core/shared";
import Link from "next/link";
import { useState, type ReactNode } from "react";
import { AiGlyph } from "@/components/ai/AiGlyph";
import { AiRingPanel } from "@/components/ai/AiRingPanel";
import { useZone } from "@/components/ZoneProvider";
import { Button } from "@/components/ui/Button";
import { aiClient } from "@/lib/ai/client";
import type { AiProfileView, AiStatus } from "@/lib/ai/types";
import { useLeaveGuard } from "../LeaveGuard";
import sp from "../settings.module.css";
import { KnowsSection, type KnowsDraft } from "./KnowsSection";
import { draftsOf, pricesOf } from "./PriceList";
import { StandingSection } from "./StandingSection";
import { VoiceSection } from "./VoiceSection";
import s from "./ai.module.css";

type Section = "knows" | "voice" | "standing";

function knowsDraft(p: AiProfile, files: AiProfileView["files"], currency: string): KnowsDraft {
  const named = new Map(files.map((f) => [f.id, f]));
  return {
    about: p.knows.about,
    faqs: p.knows.faqs.map((f) => ({ key: crypto.randomUUID(), ...f })),
    prices: draftsOf(p.knows.prices, currency),
    // A chosen file that's gone from Media altogether isn't shown (nothing to send); saving drops it.
    files: p.knows.files.flatMap((id) => {
      const f = named.get(id);
      return f ? [f] : [];
    }),
    neverSay: p.knows.neverSay.map((text) => ({ key: crypto.randomUUID(), text })),
  };
}
/** What a section's draft would save, or what's wrong with it in words. */
function patchOf(
  section: Section,
  d: { knows: KnowsDraft; voice: AiProfile["voice"]; standing: AiProfile["standing"] },
) {
  let patch: AiProfilePatch;
  if (section === "knows") {
    const prices = pricesOf(d.knows.prices);
    if ("problem" in prices) return { problem: prices.problem };
    patch = {
      knows: {
        about: d.knows.about.trim(),
        faqs: d.knows.faqs.map(({ q, a }) => ({ q: q.trim(), a: a.trim() })),
        prices: prices.prices,
        files: d.knows.files.map((f) => f.id),
        neverSay: d.knows.neverSay.map((n) => n.text.trim()).filter(Boolean),
      },
    };
  } else patch = { [section]: d[section] };
  const problem = profileProblem(patch);
  return problem ? { problem } : { patch };
}

function Panel({
  id,
  title,
  lede,
  autopilot,
  children,
  foot,
}: {
  id: string;
  title: string;
  lede: string;
  autopilot?: boolean;
  children: ReactNode;
  foot?: ReactNode;
}) {
  return (
    <section className={sp.panel} aria-labelledby={id}>
      <div className={sp.panelHead}>
        <h2 id={id} className={sp.panelTitle}>
          {title}
        </h2>
        <p className={s.panelLede}>
          {lede}
          {autopilot && <span className={s.autopilot}>Used by Autopilot</span>}
        </p>
      </div>
      <div className={sp.panelBody}>{children}</div>
      {foot && <div className={sp.panelFoot}>{foot}</div>}
    </section>
  );
}

/**
 * Settings → LUME AI (Autopilot spec 2026-10-19 §5): teach LUME AI the business once. Four sections, each saved on its
 * own: what it knows, its voice, the standing choices Autopilot starts from, and the month's use. With LUME AI off, the
 * page explains and points to Integrations, and nothing else shows. Unsaved changes ask before leaving.
 */
export function AiSettings({
  initial,
  status: firstStatus,
}: {
  initial: AiProfileView;
  status: AiStatus | null;
}) {
  const tz = useZone();
  const [status, setStatus] = useState(firstStatus);
  const [saved, setSaved] = useState(() => ({
    knows: knowsDraft(initial.profile, initial.files, initial.currency),
    voice: initial.profile.voice,
    standing: initial.profile.standing,
  }));
  const [draft, setDraft] = useState(saved);
  const [busy, setBusy] = useState<Section | null>(null);
  const [said, setSaid] = useState<Partial<Record<Section, { ok: boolean; text: string }>>>({});
  const dirtyOf = (k: Section) => JSON.stringify(draft[k]) !== JSON.stringify(saved[k]);
  const sheet = useLeaveGuard(dirtyOf("knows") || dirtyOf("voice") || dirtyOf("standing"));

  if (!status?.on)
    return (
      <div className={s.off}>
        <AiGlyph size={28} />
        <div>
          <p>
            LUME AI is off for this business. Once it&apos;s on, you teach it your business here: what you
            offer, your prices, your voice, and what it may do. LUME works in full without it.
          </p>
          <Link href="/settings/integrations" className={s.offLink}>
            Switch LUME AI on in Integrations
          </Link>
        </div>
      </div>
    );

  const edit = <K extends Section>(k: K, v: (typeof draft)[K]) => {
    setDraft((d) => ({ ...d, [k]: v }));
    setSaid((x) => ({ ...x, [k]: undefined }));
  };
  const save = async (k: Section) => {
    const p = patchOf(k, draft);
    if ("problem" in p) return setSaid((x) => ({ ...x, [k]: { ok: false, text: p.problem! } }));
    setBusy(k);
    const r = await aiClient.saveProfile(p.patch!);
    setBusy(null);
    if (!r.ok) return setSaid((x) => ({ ...x, [k]: { ok: false, text: r.message } }));
    // What the server kept, for this section only: another section's unsaved edits stay as they are.
    const next =
      k === "knows" ? knowsDraft(r.data.profile, r.data.files, r.data.currency) : r.data.profile[k];
    setSaved((x) => ({ ...x, [k]: next }));
    setDraft((x) => ({ ...x, [k]: next }));
    setSaid((x) => ({ ...x, [k]: { ok: true, text: "Saved" } }));
  };
  const foot = (k: Section, label: string) => (
    <>
      {said[k] && (
        <p role={said[k]!.ok ? "status" : "alert"} className={said[k]!.ok ? sp.saved : sp.problem}>
          {said[k]!.text}
        </p>
      )}
      <Button variant="primary" loading={busy === k} aria-label={label} onClick={() => void save(k)}>
        Save
      </Button>
    </>
  );

  return (
    <div className={`${sp.stack} ${s.page}`}>
      <p className={s.intro}>
        <AiGlyph size={20} />
        Teach LUME AI your business once. Autopilot uses what&apos;s here.
      </p>
      <Panel
        id="ai-knows"
        title="What LUME AI knows"
        lede="Your business, in your own words."
        foot={foot("knows", "Save what LUME AI knows")}
      >
        <KnowsSection value={draft.knows} currency={initial.currency} onChange={(v) => edit("knows", v)} />
      </Panel>
      <Panel
        id="ai-voice"
        title="Voice"
        lede="How it sounds when it writes for you."
        foot={foot("voice", "Save voice")}
      >
        <VoiceSection value={draft.voice} onChange={(v) => edit("voice", v)} />
      </Panel>
      <Panel
        id="ai-standing"
        title="Standing choices"
        lede="What a new run starts with. You can change any of it when you start one."
        autopilot
        foot={foot("standing", "Save standing choices")}
      >
        <StandingSection
          value={draft.standing}
          stages={initial.stages}
          speakers={initial.speakers}
          onChange={(v) => edit("standing", v)}
        />
      </Panel>
      <Panel id="ai-usage" title="Usage" lede="This month's LUME AI, on your business's clock.">
        <div className={s.usage}>
          <AiRingPanel
            st={status}
            tz={tz}
            onAsked={() => setStatus((x) => (x ? { ...x, topUp: { asked: true } } : x))}
          />
        </div>
      </Panel>
      {sheet}
    </div>
  );
}
