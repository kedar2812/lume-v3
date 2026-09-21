import type { ButtonHTMLAttributes } from "react";
import s from "./Button.module.css";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "whatsapp" | "danger";
type Props = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: "sm" | "md";
  loading?: boolean;
};

export function Button({
  variant = "secondary",
  size = "md",
  loading = false,
  disabled,
  className,
  children,
  type = "button",
  ...rest
}: Props) {
  return (
    <button
      type={type}
      data-variant={variant}
      aria-busy={loading || undefined}
      disabled={disabled || loading}
      className={[s.btn, variant !== "secondary" && s[variant], size === "sm" && s.sm, className]
        .filter(Boolean)
        .join(" ")}
      {...rest}
    >
      {/* The label stays (transparent) while loading: keeps the accessible name and the button width. */}
      <span className={loading ? s.hidden : undefined}>{children}</span>
      {loading && <span className={s.spinner} aria-hidden />}
    </button>
  );
}
