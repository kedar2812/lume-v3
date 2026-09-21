import { BarChart3, CalendarDays, Columns3, Mail, Settings, Sun, Users } from "lucide-react";
import type { IconName } from "./nav";

const MAP = {
  today: Sun,
  leads: Users,
  pipeline: Columns3,
  calendar: CalendarDays,
  templates: Mail,
  analytics: BarChart3,
  settings: Settings,
};

export function NavIcon({ name }: { name: IconName }) {
  const I = MAP[name];
  return <I size={17} strokeWidth={1.8} aria-hidden />;
}
