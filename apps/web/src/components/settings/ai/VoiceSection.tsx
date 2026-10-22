"use client";
import type { AiProfile } from "@lume/core/shared";
import { Field } from "@/components/ui/Field";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import s from "./ai.module.css";

type Voice = AiProfile["voice"];

const TONES = [
  { value: "warm", label: "Warm" },
  { value: "formal", label: "Formal" },
  { value: "casual", label: "Casual" },
] as const;
/** How a first reply might open in each tone: a fictional lead, for the feel of it. */
const SAMPLE: Record<Voice["tone"], string> = {
  warm: "Hi Meera, thanks so much for reaching out! Happy to help you plan this.",
  formal: "Hello Meera. Thank you for your enquiry. We would be glad to assist you.",
  casual: "Hey Meera! Thanks for the message, let's sort this out together.",
};
/** The languages offered beside the lead's own; codes are BCP 47, as the profile stores them. */
export const LANGUAGES: { code: string; name: string }[] = [
  { code: "en", name: "English" },
  { code: "hi", name: "Hindi" },
  { code: "mr", name: "Marathi" },
  { code: "gu", name: "Gujarati" },
  { code: "bn", name: "Bengali" },
  { code: "ta", name: "Tamil" },
  { code: "te", name: "Telugu" },
  { code: "kn", name: "Kannada" },
  { code: "ml", name: "Malayalam" },
  { code: "pa", name: "Punjabi" },
  { code: "ur", name: "Urdu" },
  { code: "ar", name: "Arabic" },
  { code: "es", name: "Spanish" },
  { code: "fr", name: "French" },
  { code: "de", name: "German" },
  { code: "pt", name: "Portuguese" },
];

/** Settings → LUME AI, Voice (Autopilot spec 2026-10-19 §5): tone, language and sign-off, with a sample line in that voice. */
export function VoiceSection({ value: v, onChange }: { value: Voice; onChange(v: Voice): void }) {
  const set = (patch: Partial<Voice>) => onChange({ ...v, ...patch });
  const known = v.language === "match_lead" || LANGUAGES.some((l) => l.code === v.language);
  return (
    <div className={s.voice}>
      <div className={s.choice}>
        <span className={s.label}>Tone</span>
        <SegmentedControl label="Tone" value={v.tone} options={TONES} onChange={(tone) => set({ tone })} />
      </div>
      <div className={s.pair}>
        <Field label="Language">
          {(c) => (
            <select {...c} value={v.language} onChange={(e) => set({ language: e.target.value })}>
              <option value="match_lead">The lead&apos;s own language</option>
              {LANGUAGES.map((l) => (
                <option key={l.code} value={l.code}>
                  {l.name}
                </option>
              ))}
              {!known && <option value={v.language}>{v.language}</option>}
            </select>
          )}
        </Field>
        <Field label="Sign-off" hint="Optional, at the end of a message.">
          {(c) => (
            <input
              {...c}
              maxLength={80}
              placeholder="Team Brightpath"
              value={v.signOff}
              onChange={(e) => set({ signOff: e.target.value })}
            />
          )}
        </Field>
      </div>
      <figure className={s.sample}>
        <figcaption>A sample line in this voice</figcaption>
        <p data-testid="voice-sample" aria-live="polite">
          {SAMPLE[v.tone]}
          {v.signOff.trim() && (
            <>
              <br />
              {v.signOff.trim()}
            </>
          )}
        </p>
      </figure>
    </div>
  );
}
