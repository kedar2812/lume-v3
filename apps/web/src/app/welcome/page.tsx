import { redirect } from "next/navigation";
import { WelcomeScreen } from "@/components/onboarding/WelcomeScreen";
import { firstRunStop } from "@/lib/first-run";
import { businessName, requireSession } from "@/server/session";

export default async function WelcomePage() {
  const session = await requireSession();
  // The agreement comes first; nothing to do here once onboarding and any required enrolment are done.
  const stop = firstRunStop(session.flags);
  if (stop !== "/welcome") redirect(stop ?? "/today");
  return <WelcomeScreen session={session} businessName={await businessName()} />;
}
