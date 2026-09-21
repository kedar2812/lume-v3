import type { ReactNode } from "react";

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd
      style={{
        font: "inherit",
        fontSize: "0.6875rem",
        fontWeight: 550,
        padding: "1px 6px",
        borderRadius: 5,
        boxShadow: "inset 0 0 0 0.5px var(--line-2)",
        color: "var(--text-3)",
      }}
    >
      {children}
    </kbd>
  );
}
