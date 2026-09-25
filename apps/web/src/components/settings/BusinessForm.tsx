"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { CountryPicker } from "@/components/ui/CountryPicker";
import { ErrorState } from "@/components/ui/ErrorState";
import { Field } from "@/components/ui/Field";
import { TimezonePicker } from "@/components/ui/TimezonePicker";
import { settingsClient, type BusinessSettings } from "@/lib/settings/client";
import { AccessChanged } from "./AccessChanged";
import { CurrencySwitch } from "./CurrencySwitch";
import { useSettingsResource } from "./useSettingsResource";
import s from "./settings.module.css";

type Editable = Pick<BusinessSettings, "businessName" | "timezone" | "defaultCountry" | "weekStart">;
const KEYS = ["businessName", "timezone", "defaultCountry", "weekStart"] as const;
const WEEK_STARTS = [
  { value: 1, label: "Monday" },
  { value: 0, label: "Sunday" },
  { value: 6, label: "Saturday" },
];

const editable = (b: BusinessSettings): Editable => ({
  businessName: b.businessName,
  timezone: b.timezone,
  defaultCountry: b.defaultCountry,
  weekStart: b.weekStart,
});

/** The business itself: its name, clock, where its leads are, when its week starts, and its one currency. */
export function BusinessForm({ initial }: { initial?: BusinessSettings }) {
  const router = useRouter();
  const res = useSettingsResource(settingsClient.get, initial ? { initial } : {});
  const [draft, setDraft] = useState<Editable | null>(initial ? editable(initial) : null);
  const [nameError, setNameError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [forbidden, setForbidden] = useState(false);

  if (forbidden || res.state === "access-changed") return <AccessChanged />;
  if (res.state === "error")
    return (
      <ErrorState
        message="Business settings couldn’t load."
        action={{ label: "Try again", onClick: res.reload }}
      />
    );
  if (!res.data) return <p className={s.muted}>Loading…</p>;
  const saved = res.data;
  const form = draft ?? editable(saved);

  const changes = Object.fromEntries(
    KEYS.filter((k) => (k === "businessName" ? form[k].trim() !== saved[k] : form[k] !== saved[k])).map(
      (k) => [k, k === "businessName" ? form[k].trim() : form[k]],
    ),
  ) as Partial<Editable>;
  const dirty = Object.keys(changes).length > 0;

  const edit = (patch: Partial<Editable>) => {
    setDraft({ ...form, ...patch });
    setStatus(null);
    setProblem(null);
    if ("businessName" in patch) setNameError(null);
  };

  const save = async () => {
    if (!form.businessName.trim()) return setNameError("Give the business a name");
    setBusy(true);
    const r = await settingsClient.patch(changes);
    setBusy(false);
    if (!res.guard(r)) {
      if (r.status !== 403) setProblem("Your changes couldn’t be saved. Try again.");
      return;
    }
    res.setData(r.data);
    setDraft(editable(r.data));
    setStatus("Saved");
    router.refresh(); // the business name and clock show elsewhere in the app
  };

  return (
    <div className={s.stack}>
      <form
        method="post"
        className={s.panel}
        aria-labelledby="business-title"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <div className={s.panelHead}>
          <h2 id="business-title" className={s.panelTitle}>
            Your business
          </h2>
        </div>
        <div className={s.panelBody}>
          <Field label="Business name" error={nameError}>
            {(control) => (
              <input
                {...control}
                value={form.businessName}
                maxLength={120}
                autoComplete="organization"
                onChange={(e) => edit({ businessName: e.target.value })}
              />
            )}
          </Field>
          <Field label="Timezone" hint="Every “today”, digest and reminder uses this zone.">
            {(control) => (
              <TimezonePicker
                control={control}
                value={form.timezone}
                onChange={(timezone) => edit({ timezone })}
              />
            )}
          </Field>
          <div className={s.pair}>
            <Field label="Most leads are in" hint="Phone numbers start with this country’s code.">
              {(control) => (
                <CountryPicker
                  id={control.id}
                  label="Most leads are in"
                  value={form.defaultCountry}
                  onChange={(defaultCountry) => edit({ defaultCountry })}
                />
              )}
            </Field>
            <Field label="Week starts on">
              {(control) => (
                <select
                  {...control}
                  value={form.weekStart}
                  onChange={(e) => edit({ weekStart: Number(e.target.value) })}
                >
                  {WEEK_STARTS.map((w) => (
                    <option key={w.value} value={w.value}>
                      {w.label}
                    </option>
                  ))}
                </select>
              )}
            </Field>
          </div>
        </div>
        <div className={s.panelFoot}>
          {status && (
            <p role="status" className={s.saved}>
              {status}
            </p>
          )}
          {problem && (
            <p role="alert" className={s.problem}>
              {problem}
            </p>
          )}
          <Button type="submit" disabled={!dirty || busy}>
            Save changes
          </Button>
        </div>
      </form>
      <CurrencySwitch
        current={saved.currency}
        onForbidden={() => setForbidden(true)}
        onSwitched={(currency) => {
          res.setData({ ...saved, currency });
          router.refresh(); // every amount on every screen is now in the new currency
        }}
      />
    </div>
  );
}
