"use client";
import { costOf, metaCategoryOf, templateProblems, type TemplateCategory } from "@lume/core/shared";
import { useEffect, useId, useState } from "react";
import { Button } from "@/components/ui/Button";
import { WhatsAppIcon } from "@/components/ui/WhatsAppIcon";
import { FilePicker } from "@/components/whatsapp/FilePicker";
import type { LibraryFile } from "@/lib/files/client";
import { templatesClient, type WhatsAppSubmission } from "@/lib/templates/client";
import { aboutCost } from "@/lib/whatsapp/cost";
import s from "./approval.module.css";

type Category = WhatsAppSubmission["category"];
const LANGUAGES = [
  { code: "en", name: "English" },
  { code: "en_GB", name: "English (UK)" },
  { code: "en_US", name: "English (US)" },
  { code: "hi", name: "Hindi" },
  { code: "mr", name: "Marathi" },
  { code: "gu", name: "Gujarati" },
  { code: "ta", name: "Tamil" },
  { code: "ar", name: "Arabic" },
  { code: "es", name: "Spanish" },
  { code: "fr", name: "French" },
  { code: "pt_BR", name: "Portuguese (Brazil)" },
  { code: "de", name: "German" },
];
const india = costOf("IN", "MARKETING");
const CATEGORIES: { key: Category; name: string; line: string }[] = [
  {
    key: "MARKETING",
    name: "Marketing",
    line: `Offers, follow-ups and bringing people back.${india ? ` WhatsApp charges ${aboutCost(india)} each in India.` : ""}`,
  },
  {
    key: "UTILITY",
    name: "Utility",
    line: "Reminders about something the lead already has, like a visit. WhatsApp charges for these too.",
  },
];
const languageName = (code: string) => LANGUAGES.find((l) => l.code === code)?.name ?? code;

/** Where one submission stands, in words, and its dot's colour. */
function standing(x: WhatsAppSubmission): { words: string; tone: "wait" | "ok" | "bad" | "off" } {
  switch (x.status) {
    case "approved":
      return x.current ? { words: "Approved", tone: "ok" } : { words: "Edited since approval", tone: "wait" };
    case "rejected":
      return { words: `Turned down: ${x.reason ?? "WhatsApp gave no reason."}`, tone: "bad" };
    case "paused":
      return { words: "Paused by WhatsApp", tone: "off" };
    case "disabled":
      return { words: "Turned off by WhatsApp", tone: "off" };
    case "failed":
      return { words: `Didn't reach WhatsApp: ${x.reason ?? "try again."}`, tone: "bad" };
    default:
      return { words: "With WhatsApp for review", tone: "wait" };
  }
}

/**
 * A template's WhatsApp approval (plan W3b-2 Task 7): to reach someone outside WhatsApp's 24 hours, or who never wrote,
 * WhatsApp approves the words first. The language, the category (and what it costs), an optional file at the top from
 * the library, what WhatsApp would turn down (live, as the words change), Submit, and where each account stands.
 */
export function WhatsAppApproval({
  templateId,
  body,
  kind,
  dirty,
  readOnly,
}: {
  templateId: string;
  /** The words as they are in the editor now. */
  body: string;
  kind: TemplateCategory;
  /** Unsaved changes: the saved words are what would go, so they're saved first. */
  dirty: boolean;
  readOnly: boolean;
}) {
  const id = useId();
  const [subs, setSubs] = useState<WhatsAppSubmission[] | null>(null);
  const [on, setOn] = useState(false);
  const [language, setLanguage] = useState("en");
  const [category, setCategory] = useState<Category>(metaCategoryOf(kind));
  const [header, setHeader] = useState<LibraryFile | null>(null);
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void templatesClient.whatsapp(templateId).then((r) => {
      if (!live) return;
      setSubs(r.ok ? r.data.submissions : []);
      setOn(r.ok && r.data.on);
    });
    return () => {
      live = false;
    };
  }, [templateId]);
  useEffect(() => setCategory(metaCategoryOf(kind)), [kind]);

  // WhatsApp isn't set up here (an optional integration): nothing of it, unless it was before and has history.
  if (subs === null || (!on && subs.length === 0)) return null;
  const problems = templateProblems(
    body,
    header && header.kind !== "audio"
      ? { kind: header.kind, size: header.size, mime: header.mime }
      : undefined,
  );
  const thisVersion = (subs ?? []).filter((x) => x.current && x.language === language);
  const waiting = thisVersion.some((x) => ["submitting", "pending", "approved"].includes(x.status));
  const turnedDown = thisVersion.some((x) => x.status === "rejected");
  const again = (subs ?? []).length > 0;
  const blocked = !on || dirty || problems.length > 0 || waiting || turnedDown || busy;

  const submit = async () => {
    setBusy(true);
    setError(null);
    const r = await templatesClient.submitToWhatsApp(templateId, {
      language,
      category,
      ...(header ? { headerFileId: header.id } : {}),
    });
    setBusy(false);
    if (!r.ok) return setError(r.message);
    setSubs(r.data.submissions);
  };

  return (
    <section className={s.approval} aria-label="WhatsApp approval">
      <div className={s.head}>
        <WhatsAppIcon size={18} />
        <h3 className={s.title}>WhatsApp approval</h3>
      </div>
      <p className={s.lede}>
        To send it to someone outside WhatsApp&apos;s 24 hours, or who never wrote, WhatsApp approves it
        first. It usually answers within a day.
      </p>

      {subs && subs.length > 0 && (
        <ul className={s.standing} aria-label="Where it stands">
          {subs.map((x) => {
            const st = standing(x);
            return (
              <li key={x.id} className={s.row}>
                <span className={s.chip} data-status={st.tone}>
                  <span className={s.dot} aria-hidden />
                  {st.words}
                </span>
                <span className={s.where}>
                  {x.account} · {languageName(x.language)} ·{" "}
                  {x.category === "UTILITY" ? "Utility" : "Marketing"}
                </span>
              </li>
            );
          })}
        </ul>
      )}

      {!readOnly && (
        <>
          <div className={s.fields}>
            <label className={s.field}>
              <span className={s.label}>Language</span>
              <select className={s.select} value={language} onChange={(e) => setLanguage(e.target.value)}>
                {LANGUAGES.map((l) => (
                  <option key={l.code} value={l.code}>
                    {l.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <span className={s.label} id={`${id}-cat`}>
            WhatsApp&apos;s category
          </span>
          <div role="radiogroup" aria-labelledby={`${id}-cat`} className={s.cats}>
            {CATEGORIES.map((c) => (
              <button
                key={c.key}
                type="button"
                role="radio"
                aria-checked={category === c.key}
                className={s.cat}
                onClick={() => setCategory(c.key)}
              >
                <span className={s.catName}>{c.name}</span>
                <span className={s.catLine}>{c.line}</span>
              </button>
            ))}
          </div>

          <div className={s.header}>
            {header ? (
              <div className={s.chosen}>
                <span className={s.chosenName}>{header.name}</span>
                <span className={s.chosenMeta}>At the top of the message</span>
                <Button size="sm" variant="ghost" onClick={() => setHeader(null)}>
                  Remove
                </Button>
              </div>
            ) : (
              <Button
                size="sm"
                variant="secondary"
                aria-expanded={picking}
                onClick={() => setPicking((v) => !v)}
              >
                Add a file at the top
              </Button>
            )}
            {picking && !header && (
              <div className={s.picker}>
                <FilePicker
                  kinds={["image", "video", "document"]}
                  onPick={(f) => {
                    setHeader(f);
                    setPicking(false);
                  }}
                />
              </div>
            )}
          </div>

          {problems.length > 0 && (
            <ul className={s.problems} aria-label="What WhatsApp would turn down">
              {problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          )}
          {dirty && <p className={s.note}>Save your changes first.</p>}
          {!dirty && waiting && (
            <p className={s.note}>These words are with WhatsApp in {languageName(language)}.</p>
          )}
          {!dirty && turnedDown && <p className={s.note}>Change the words, save, then submit them again.</p>}
          {error && (
            <p role="alert" className={s.error}>
              {error}
            </p>
          )}
          <div className={s.foot}>
            <Button
              variant="whatsapp"
              size="sm"
              disabled={blocked}
              loading={busy}
              onClick={() => void submit()}
            >
              {again ? "Submit again" : "Submit to WhatsApp"}
            </Button>
          </div>
        </>
      )}
    </section>
  );
}
