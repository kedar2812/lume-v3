"use client";
import { matchEvent, type CalendarRules as Rules } from "@lume/core/shared";
import { useState } from "react";
import { Switch } from "@/components/ui/Switch";
import { calendarClient } from "@/lib/calendar/client";
import s from "./calendar-settings.module.css";

/** A fictional week (no real person's calendar): what the rules would keep from it. */
const SAMPLE_LEADS = new Map([
  ["dana.whitfield@example.com", "Dana"],
  ["karim.aziz@example.com", "Karim"],
  ["noor.rahman@example.com", "Noor"],
]);
type SampleEvent = {
  when: string;
  title: string;
  who: string;
  calendar: "own" | "team";
  attendees: string[];
};
const SAMPLE: SampleEvent[] = [
  {
    when: "Mon 10:00",
    title: "Discovery call",
    who: "Dana Whitfield (a lead)",
    calendar: "own",
    attendees: ["dana.whitfield@example.com"],
  },
  { when: "Mon 13:00", title: "Dentist", who: "Just you", calendar: "own", attendees: [] },
  {
    when: "Tue 09:00",
    title: "Team stand-up",
    who: "Hana, Rory",
    calendar: "team",
    attendees: ["hana@brightpath.example", "rory@brightpath.example"],
  },
  {
    when: "Tue 11:30",
    title: "Pricing walkthrough",
    who: "Karim Aziz (a lead)",
    calendar: "own",
    attendees: ["karim.aziz@example.com"],
  },
  { when: "Tue 18:00", title: "Gym", who: "Just you", calendar: "own", attendees: [] },
  {
    when: "Wed 10:30",
    title: "Discovery call — new enquiry",
    who: "j.ortega@mail.example",
    calendar: "own",
    attendees: ["j.ortega@mail.example"],
  },
  {
    when: "Wed 15:00",
    title: "Product demo",
    who: "tom@company.example",
    calendar: "own",
    attendees: ["tom@company.example"],
  },
  {
    when: "Thu 12:30",
    title: "Lunch with Sam",
    who: "sam@friends.example",
    calendar: "own",
    attendees: ["sam@friends.example"],
  },
  { when: "Thu 16:00", title: "Site visit, Al Barsha", who: "Just you", calendar: "team", attendees: [] },
  { when: "Fri 15:30", title: "School pickup", who: "Just you", calendar: "own", attendees: [] },
  {
    when: "Fri 17:00",
    title: "Quarterly review",
    who: "Noor Rahman (a lead)",
    calendar: "team",
    attendees: ["noor.rahman@example.com"],
  },
];

/**
 * Settings → Calendar rules (canvas Rules): which events are meetings with leads, for everyone's calendar.
 * Three rules with green switches, and a sample week that shows, as you change them, what would come in.
 * A rule switched off keeps nothing, whatever was typed into it.
 */
export function CalendarRules({
  initial,
  calendars,
}: {
  initial: Rules;
  /** The admin's own connected calendars, to choose from for rule 3 (none: say how to get them). */
  calendars: { id: string; name: string }[];
}) {
  const [attendee, setAttendee] = useState(initial.attendeeIsLead);
  const [wordsOn, setWordsOn] = useState(initial.titleWords.length > 0);
  const [words, setWords] = useState(initial.titleWords);
  const [calsOn, setCalsOn] = useState(initial.calendarIds.length > 0);
  const [cals, setCals] = useState(initial.calendarIds);
  const [draft, setDraft] = useState("");
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const rules: Rules = {
    attendeeIsLead: attendee,
    titleWords: wordsOn ? words : [],
    calendarIds: calsOn ? cals : [],
  };
  // Eleven events: worked out on every render, so the sample never lags the switches.
  const kept = SAMPLE.map((e) =>
    matchEvent(
      { title: e.title, attendees: e.attendees },
      {
        leadsByEmail: SAMPLE_LEADS,
        // The sample's "team" calendar stands for whichever calendars are chosen.
        rules: { ...rules, calendarIds: rules.calendarIds.length ? ["sample-team"] : [] },
        calendarId: e.calendar === "team" ? "sample-team" : "sample-own",
      },
    ),
  );
  const count = kept.filter(Boolean).length;
  const touch = () => {
    setSaved(false);
    setError(null);
  };
  const addWord = () => {
    const w = draft.trim();
    if (w && !words.some((x) => x.toLowerCase() === w.toLowerCase())) setWords([...words, w]);
    setDraft("");
    touch();
  };
  const save = async () => {
    touch();
    const r = await calendarClient.saveRules(rules);
    if (!r.ok) return setError(r.message);
    setSaved(true);
  };

  return (
    <div className={s.rulesGrid}>
      <div className={s.rules}>
        <div className={s.rule} data-on={attendee || undefined}>
          <span className={s.num}>1</span>
          <div className={s.ruleHead}>
            <div>
              <b>An attendee is a lead</b>
              <small>Someone invited has the email of a lead. The meeting goes on that lead.</small>
            </div>
            <Switch
              label="An attendee is a lead"
              labelHidden
              checked={attendee}
              onChange={(v) => (setAttendee(v), touch())}
            />
          </div>
        </div>

        <div className={s.rule} data-on={wordsOn || undefined}>
          <span className={s.num}>2</span>
          <div>
            <div className={s.ruleHead}>
              <div>
                <b>The title has a word</b>
                <small>Kept even before the person is a lead; attach it to one in a tap.</small>
              </div>
              <Switch
                label="The title has a word"
                labelHidden
                checked={wordsOn}
                onChange={(v) => (setWordsOn(v), touch())}
              />
            </div>
            {wordsOn && (
              <div className={s.words}>
                {words.map((w) => (
                  <span key={w} className={s.word}>
                    {w}
                    <button
                      type="button"
                      aria-label={`Remove ${w}`}
                      onClick={() => (setWords(words.filter((x) => x !== w)), touch())}
                    >
                      ×
                    </button>
                  </span>
                ))}
                <input
                  className={s.wordInput}
                  aria-label="A word or phrase"
                  placeholder="Discovery call, Consultation…"
                  value={draft}
                  maxLength={100}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === ",") {
                      e.preventDefault();
                      addWord();
                    }
                  }}
                  onBlur={addWord}
                />
              </div>
            )}
          </div>
        </div>

        <div className={s.rule} data-on={calsOn || undefined}>
          <span className={s.num}>3</span>
          <div>
            <div className={s.ruleHead}>
              <div>
                <b>This calendar counts</b>
                <small>Every event on these calendars, put on a lead by its attendees when it can be.</small>
              </div>
              <Switch
                label="This calendar counts"
                labelHidden
                checked={calsOn}
                onChange={(v) => (setCalsOn(v), touch())}
              />
            </div>
            {calsOn &&
              (calendars.length ? (
                <div className={s.checks}>
                  {calendars.map((c) => (
                    <label key={c.id}>
                      <input
                        type="checkbox"
                        checked={cals.includes(c.id)}
                        onChange={(e) => {
                          setCals(e.target.checked ? [...cals, c.id] : cals.filter((x) => x !== c.id));
                          touch();
                        }}
                      />
                      {c.name}
                    </label>
                  ))}
                </div>
              ) : (
                <p className={s.never}>
                  Connect your own calendar in Settings → Calendar to choose its calendars.
                </p>
              ))}
          </div>
        </div>

        <p className={s.never}>
          <svg
            viewBox="0 0 24 24"
            width="12"
            height="12"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            aria-hidden
          >
            <rect x="5" y="11" width="14" height="9" rx="2" />
            <path d="M8 11V8a4 4 0 0 1 8 0v3" />
          </svg>
          Never counted: people who sign in to LUME, and each person&apos;s own address.
        </p>

        <div className={s.saveRow}>
          <button type="button" className={s.save} onClick={() => void save()}>
            Save
          </button>
          <span role="status" className={s.saved}>
            {saved ? "Saved" : ""}
          </span>
          {error && (
            <span role="alert" className={s.err}>
              {error}
            </span>
          )}
        </div>
      </div>

      <section className={s.sample} aria-label="A sample week">
        <div className={s.sampleHead}>
          <small>A sample week</small>
          <p data-testid="sample-count">
            <b>{count}</b> of {SAMPLE.length} events become meetings
          </p>
        </div>
        {SAMPLE.map((e, i) => {
          const m = kept[i];
          return (
            <div key={e.when + e.title} className={s.ev} data-kept={m ? true : undefined}>
              <small>{e.when}</small>
              <span>
                <b>{e.title}</b>
                <small>
                  {e.who} · {e.calendar === "team" ? "Sales team" : "Maya"}
                </small>
              </span>
              <span className={s.tag}>
                {m ? `Meeting${m.leadId ? ` · with ${m.leadId}` : ""}` : "Not stored"}
              </span>
            </div>
          );
        })}
      </section>
    </div>
  );
}
