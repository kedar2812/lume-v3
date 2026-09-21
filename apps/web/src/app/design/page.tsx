import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { THEME_COOKIE, parseThemePref } from "@/lib/theme";
import { Showcase } from "./Showcase";

export const metadata = { title: "Design system · LUME" };

export default async function DesignPage() {
  if (process.env.NODE_ENV === "production" && process.env.LUME_DESIGN_SHOWCASE !== "1") notFound();
  const theme = parseThemePref((await cookies()).get(THEME_COOKIE)?.value);
  return <Showcase theme={theme} />;
}
