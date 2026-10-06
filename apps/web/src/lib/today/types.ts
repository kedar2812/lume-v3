/**
 * Today's tiles (GET /api/v1/today/tiles; spec 2026-10-05-today-control-centre-design.md). A tile the viewer may not
 * see is absent, never zero.
 */
export type Tiles = {
  leads?: {
    day: string;
    /** The hour it is now on the business's clock. */
    hourNow: number;
    today: number;
    /** Leads in by this time on the same weekday last week. */
    lastWeek: number;
    /** Today's arrivals by the hour they entered LUME (24); they add up to `today`. */
    hours: number[];
    /** The average for this weekday over the last weeks LUME was in use; null under two of them. */
    usual: number[] | null;
    weeks: number;
    reached: number;
    medianMinutes: number | null;
  };
  month?: {
    money: boolean;
    from: string;
    to: string;
    value: number;
    previous: number;
    won: number;
    goal: {
      scope: "user" | "team" | "business";
      target: number;
      value: number;
      elapsed: number;
      pace: number | null;
      daysLeft: number;
    } | null;
  };
  pipeline?: {
    name: string;
    many: boolean;
    open: number;
    openEverywhere: number | null;
    stages: { id: string; name: string; n: number }[];
    wonThisMonth: number;
    forecast: number | null;
  };
  calendar: {
    weekStart: string;
    todayIndex: number;
    week: number[];
    today: number;
    held: number;
    connected: boolean;
  };
  team?: { overdue: number; people: { id: string; name: string; n: number }[]; onTime: number | null };
  streak?: { days: number; best: number; dueToday: number; doneToday: number; last7: ("ok" | "missed")[] };
  replies?: {
    rate: number | null;
    previous: number | null;
    series: (number | null)[];
    best: { name: string; rate: number; sends: number } | null;
  };
};
