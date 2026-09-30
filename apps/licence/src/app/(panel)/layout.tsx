import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { Shell } from "@/components/Shell";
import { sessionAdmin, SESSION_COOKIE } from "@/server/auth";
import { context } from "@/server/context";

export const dynamic = "force-dynamic";

/** Every panel screen: signed in, or to the sign-in. */
export default async function PanelLayout({ children }: { children: ReactNode }) {
  if (!(await sessionAdmin(context(), (await cookies()).get(SESSION_COOKIE)?.value ?? null)))
    redirect("/sign-in");
  return <Shell>{children}</Shell>;
}
