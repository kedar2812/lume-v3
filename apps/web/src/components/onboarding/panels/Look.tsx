import type { ThemePref } from "@/lib/theme";
import s from "../onboarding.module.css";
import { PanelHead } from "./Head";

const TILES: { id: ThemePref; name: string; detail: string }[] = [
  { id: "porcelain", name: "Porcelain", detail: "Bright and airy" },
  { id: "obsidian", name: "Obsidian", detail: "Deep and calm" },
  { id: "system", name: "Match device", detail: "Follows your system" },
];

/** Picking a tile previews it at once, through the glass; saving happens on Continue. */
export function LookPanel({
  kicker,
  theme,
  onTheme,
}: {
  kicker: string;
  theme: ThemePref;
  onTheme: (t: ThemePref) => void;
}) {
  return (
    <>
      <PanelHead
        kicker={kicker}
        title="How should LUME look?"
        lead="Try them. Everything behind this sheet changes as you pick. This is just for you."
      />
      <div className={s.tiles} role="radiogroup" aria-label="Theme">
        {TILES.map((t) => (
          <button
            key={t.id}
            type="button"
            role="radio"
            aria-checked={theme === t.id}
            className={s.tile}
            onClick={() => onTheme(t.id)}
          >
            <span className={s.preview} data-look={t.id} aria-hidden>
              <span className={s.pvSide}>
                <i />
                <i />
                <i />
              </span>
              <span className={s.pvMain} />
            </span>
            <b>{t.name}</b>
            <span>{t.detail}</span>
          </button>
        ))}
      </div>
    </>
  );
}
