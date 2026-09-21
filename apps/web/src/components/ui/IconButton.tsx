import type { ButtonHTMLAttributes, ReactNode } from "react";
import s from "./Button.module.css";

type Props = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "aria-label"> & {
  label: string;
  children: ReactNode;
};

/** Icon-only button. `label` is mandatory: it's the accessible name and the tooltip. */
export function IconButton({ label, className, children, type = "button", ...rest }: Props) {
  return (
    <button
      type={type}
      aria-label={label}
      title={label}
      className={[s.btn, s.ghost, className].filter(Boolean).join(" ")}
      style={{ width: 34, padding: 0 }}
      {...rest}
    >
      {children}
    </button>
  );
}
