/**
 * Made-up names for the demo business (8D spec §3): generic, fictional, from many places, never a real client's. The
 * business, its people, sources, packages and tags are described by what they are, not who.
 */
export const FIRST = [
  "Aanya",
  "Aarav",
  "Adele",
  "Ahmed",
  "Aiko",
  "Alina",
  "Amara",
  "Ana",
  "Anika",
  "Arjun",
  "Ayaan",
  "Bea",
  "Carlos",
  "Chloe",
  "Daniel",
  "Diya",
  "Elena",
  "Emeka",
  "Farah",
  "Felix",
  "Gaurav",
  "Hana",
  "Ibrahim",
  "Ines",
  "Isha",
  "Jonas",
  "Kabir",
  "Kavya",
  "Kenji",
  "Lara",
  "Leila",
  "Luca",
  "Maya",
  "Meera",
  "Mateo",
  "Mira",
  "Nadia",
  "Neel",
  "Nisha",
  "Noah",
  "Omar",
  "Priya",
  "Rahul",
  "Rania",
  "Rohan",
  "Sara",
  "Sofia",
  "Tara",
  "Tomas",
  "Vikram",
  "Yara",
  "Zain",
  "Zoya",
] as const;

export const LAST = [
  "Ahmed",
  "Alvarez",
  "Bose",
  "Costa",
  "Das",
  "Fischer",
  "Gupta",
  "Haddad",
  "Ito",
  "Iyer",
  "Joshi",
  "Kapoor",
  "Khan",
  "Kim",
  "Kumar",
  "Lal",
  "Lin",
  "Malik",
  "Martins",
  "Mehta",
  "Menon",
  "Nair",
  "Novak",
  "Okafor",
  "Pillai",
  "Qureshi",
  "Rao",
  "Reddy",
  "Rossi",
  "Sato",
  "Sen",
  "Shah",
  "Silva",
  "Singh",
  "Tan",
  "Varma",
  "Weber",
  "Yadav",
] as const;

/** The demo's people: Leo is the one whose follow-ups slip on Mondays and who contacts leads slowest. */
export const PEOPLE = [
  { name: "Riya Shah", team: "Inbound" },
  { name: "Dev Malhotra", team: "Inbound" },
  { name: "Sana Qureshi", team: "Inbound" },
  { name: "Aarav Mehta", team: "Inbound" },
  { name: "Mei Lin", team: "Inbound" },
  { name: "Hana Ito", team: "Field" },
  { name: "Leo Martins", team: "Field" },
  { name: "Omar Haddad", team: "Field" },
] as const;

/** Sources, by what they are; a monthly spend on the paid ones. Referrals win most, webinars cost most per win. */
export const SOURCES = [
  { name: "Instagram ads", weight: 0.35, win: 1, spend: 180_000 },
  { name: "Website form", weight: 0.3, win: 1, spend: null },
  { name: "Referrals", weight: 0.12, win: 3, spend: null },
  { name: "Webinars", weight: 0.13, win: 0.25, spend: 45_000 },
  { name: "Walk-in", weight: 0.1, win: 1.1, spend: null },
] as const;

export const PRODUCTS = [
  { name: "Starter", value: 25_000, weight: 0.45 },
  { name: "Growth", value: 40_000, weight: 0.4 },
  { name: "Premium", value: 90_000, weight: 0.15 },
] as const;

export const TAGS = ["café", "wedding", "repeat client"] as const;
/** A choice field's answers, in no currency (the business picks its own). */
export const BUDGET = ["Small", "Medium", "Large"] as const;
/** Lost reasons the demo adds only if the business has none. */
export const REASONS = ["No reply", "Chose someone else", "Too expensive", "Not the right time"] as const;

/** What a booked call is called in the demo calendar (fictional, generic). */
export const MEETING_TITLES = [
  "Discovery call",
  "Pricing walkthrough",
  "Programme fit call",
  "Check-in",
  "Onboarding call",
  "Intro call",
] as const;
