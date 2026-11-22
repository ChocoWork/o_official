/**
 * メールのコードの入力画面のページ（src/app/login/code/page.tsx）。
 *
 * @packageDocumentation
 * @impl IMPL-AUTH-313
 * @design DD-AUTH-062
 * @remarks 判定をサーバーに置くのは、判定前に入力画面の HTML を送らないため。
 * 不在・改竄・期限切れをすべて同じ扱いで `/login` へ送り、アカウントの存在を示唆しない。
 */
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { emailCodeSessionCookieName } from "@/lib/cookie";
import { verifyEmailCodeSessionToken } from "@/features/auth/services/email-code-session";
import EmailCodeEntry from "@/features/auth/passkey/components/EmailCodeEntry";

export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

export default async function LoginCodePage() {
  const store = await cookies();
  const pending = verifyEmailCodeSessionToken(store.get(emailCodeSessionCookieName)?.value);

  if (!pending) {
    redirect("/login");
  }

  return <EmailCodeEntry email={pending.email} />;
}
