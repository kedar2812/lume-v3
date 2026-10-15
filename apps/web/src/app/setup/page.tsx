import { redirect } from "next/navigation";
import { SetupScreen } from "@/components/setup/SetupScreen";
import { apiGet } from "@/server/api";

export default async function SetupPage() {
  const { data } = await apiGet<{ needsSetup: boolean; needsKey?: boolean }>("/api/v1/setup/status");
  // Already set up: the wizard must never be reachable a second time.
  if (!data?.needsSetup) redirect("/sign-in");
  return <SetupScreen needsKey={data.needsKey === true} />;
}
