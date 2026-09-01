import { redirect } from "next/navigation";
import type { Metadata } from "next";
import VerifyClient from "./VerifyClient";

export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

/**
 * メールのリンク先。ここでは何も消費しない。
 *
 * トークンの消費を GET で行うと、企業メールのリンクスキャナが受信時に踏んで
 * 先に潰してしまう。再送しても新しいリンクが同じようにスキャンされるため、
 * 該当利用者は再設定できなくなる。ボタン（POST）を挟んでそれを避ける。
 */
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
