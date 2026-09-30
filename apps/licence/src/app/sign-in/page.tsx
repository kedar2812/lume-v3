import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SignIn } from "@/components/SignIn";
import { sessionAdmin, SESSION_COOKIE } from "@/server/auth";
import { context } from "@/server/context";

export const dynamic = "force-dynamic";
export const metadata = { title: "Sign in · LUME Licences" };

export default async function SignInPage() {
  if (await sessionAdmin(context(), (await cookies()).get(SESSION_COOKIE)?.value ?? null))
    redirect("/clients");
  return <SignIn />;
}
