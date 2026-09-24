import { SignInScreen } from "@/components/auth/SignInScreen";
import { publicBusinessName } from "@/server/public-settings";

/** Only in-app paths, so a crafted ?next= can never bounce someone off-site. */
const safeNext = (next: string | undefined): string =>
  next && /^\/[A-Za-z0-9\-_/]*$/.test(next) ? next : "/today";

export default async function SignInPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next } = await searchParams;
  return <SignInScreen businessName={await publicBusinessName()} next={safeNext(next)} />;
}
