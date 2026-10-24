import { BarChart3, CalendarDays, Columns3, Image, Mail, Settings, Sun, Users } from "lucide-react";
import type { LucideProps } from "lucide-react";
import type { IconName } from "./nav";

/** LUME AI's Loop, drawn as a line in the text's colour so it sits with the other nav icons. */
function Loop({ size = 24, strokeWidth = 2, ...rest }: LucideProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" {...rest}>
      <path
        d="M3.84 20.16C8.16 20.16 12.48 17.28 14.4 12.48C16.8 6.72 15.36 2.4 12.24 2.88C9.12 3.36 8.64 8.64 10.32 13.68C12 18.48 15.84 20.64 19.68 18.96"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

const MAP = {
  today: Sun,
  leads: Users,
  autopilot: Loop,
  pipeline: Columns3,
  calendar: CalendarDays,
  templates: Mail,
  media: Image,
  analytics: BarChart3,
  settings: Settings,
};

export function NavIcon({ name }: { name: IconName }) {
  const I = MAP[name];
  return <I size={17} strokeWidth={1.8} aria-hidden />;
}
