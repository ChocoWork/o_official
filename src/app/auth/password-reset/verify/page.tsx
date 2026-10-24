/**
 * パスワード再設定のメールのリンク先の頁（src/app/auth/password-reset/verify/page.tsx）。
 *
 * @packageDocumentation
 * @impl IMPL-AUTH-105
 * @design DD-AUTH-004
 * @remarks ここでは何も消費しない。
 * トークンを焼くのは confirm（実際にパスワードを変えたとき）だけ。リンクを開いた
 * 時点で焼くと、企業メールのリンクスキャナが受信時に踏んで先に潰してしまい、
 * 再送しても新しいリンクが同じようにスキャンされて再設定できなくなる。
 */
import { redirect } from "next/navigation";
import type { Metadata } from "next";
import VerifyClient from "./VerifyClient";

export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

export default async function PasswordResetVerifyPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;

  if (!token) {
    redirect("/auth/password-reset?error=link_invalid");
  }

  return <VerifyClient token={token} />;
}
