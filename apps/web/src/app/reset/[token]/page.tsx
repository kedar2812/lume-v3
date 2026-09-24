import { notFound } from "next/navigation";
import { ResetScreen } from "@/components/auth/ResetScreen";
import { publicBusinessName } from "@/server/public-settings";

export default async function ResetPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) notFound();
  return <ResetScreen token={token} businessName={await publicBusinessName()} />;
}
