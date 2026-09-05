import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { loginTwoFactorSessionCookieName } from "@/lib/cookie";
import { verifyLoginTwoFactorSessionToken } from "@/features/auth/services/login-2fa-session";
import VerifyOtpClient from "./VerifyOtpClient";

export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

/**
 * 認証コードの入力画面。
 *
 * 判定をサーバーに置くのは、判定前に入力画面の HTML を送らないため。
 * クライアント判定にすると、リダイレクトされるまでの一瞬フォームが見える。
 * 不在・改竄・期限切れをすべて同じ扱いにして、アカウントの存在を示唆しない。
 */
export default async function LoginVerifyPage() {
  const store = await cookies();
  const session = verifyLoginTwoFactorSessionToken(
    store.get(loginTwoFactorSessionCookieName)?.value,
  );

  if (!session) {
    redirect("/login");
  }

  return <VerifyOtpClient email={session.email} />;
}
