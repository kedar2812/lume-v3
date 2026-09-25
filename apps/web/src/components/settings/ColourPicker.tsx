"use client";
import { Popover } from "@/components/ui/Popover";
import { tokenColor } from "@/lib/leads/colors";
import s from "./settings.module.css";

/** The colour tokens the API accepts, with the names people see. */
export const COLOURS = [
  ["accent", "Blue"],
  ["cyan", "Cyan"],
  ["ok", "Green"],
  ["warn", "Amber"],
  ["danger", "Red"],
  ["meet", "Violet"],
  ["neutral", "Grey"],
] as const;
export type ColourToken = (typeof COLOURS)[number][0];

/** A swatch that opens the palette as radios; picking one closes it and reports the token. */
export function ColourPicker({
  label,
  value,
  onChange,
}: {
  /** "Colour for New": the trigger's and the palette's name. */
  label: string;
  value: string;
  onChange: (token: ColourToken) => void;
}) {
  return (
    <Popover
      label={label}
      triggerClassName={s.swatchBtn}
      trigger={
        <>
          <span className={s.swatch} style={{ background: tokenColor(value) }} aria-hidden />
          <span className={s.srOnly}>{label}</span>
        </>
      }
    >
      {(close) => (
        <div role="radiogroup" aria-label={label} className={s.swatches}>
          {COLOURS.map(([token, name]) => (
            <label key={token} className={s.swatchChoice} title={name}>
              <input
                type="radio"
                name={label}
                aria-label={name}
                checked={value === token}
                onChange={() => {
                  close();
                  onChange(token);
                }}
              />
              <span className={s.swatch} style={{ background: tokenColor(token) }} aria-hidden />
            </label>
          ))}
        </div>
      )}
    </Popover>
  );
}
