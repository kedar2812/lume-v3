import { notFound } from "next/navigation";
import { AcceptInviteScreen } from "@/components/auth/AcceptInviteScreen";
import { apiGet } from "@/server/api";

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) notFound();
  const { status, data } = await apiGet<{ email: string; name: string; businessName: string }>(
    `/api/v1/invites/${token}`,
  );
  // Unknown, used or expired is a 404 from the API and a 404 here: no hints either way.
  if (status !== 200 || !data) notFound();
  return <AcceptInviteScreen token={token} invite={data} />;
}
