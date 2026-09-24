import { redirect } from "next/navigation";
import { SignInScreen } from "@/components/auth/SignInScreen";
import { safeNext } from "@/lib/safe-next";
import { needsSetup, publicBusinessName } from "@/server/public-settings";
import { getSession } from "@/server/session";

export default async function SignInPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next } = await searchParams;
  // Already signed in (a bookmark, the back button, a second tab): go where they were heading.
  if (await getSession()) redirect(safeNext(next));
  // A brand-new installation has nobody to sign in yet: the way in is the setup wizard.
  if (await needsSetup()) redirect("/setup");
  return <SignInScreen businessName={await publicBusinessName()} next={safeNext(next)} />;
}
