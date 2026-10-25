/**
 * ログイン・会員登録の頁（src/app/login/page.tsx）。
 *
 * @packageDocumentation
 * @impl IMPL-AUTH-101
 * @design DD-AUTH-001
 * @remarks 認証コードの入力の途中で戻ってきた人に資格情報のフォームを見せると、
 * もう一度ログインを押して2通目のコードを送り、アカウント単位の枠を無駄に使う。
 * そのため保留の Cookie が有効なら描く前にサーバーで転送する。
 * 初めのタブとメールを問い合わせで受けるのは、ゲストの注文の完了画面などが会員登録への案内にその二つを付けて来るため。
 * `next`（ログインの後の戻り先）は確かめを通った道筋だけを AuthTabs に渡し、外れた値は画面に出さず捨てる。
 * 控えるのは入口の POST で、ここは値を運ぶだけ（ARC-AUTH-010）。
 */
import type { Metadata } from 'next';
import React from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import AuthTabs from "@/components/AuthTabs";
import { loginTwoFactorSessionCookieName } from "@/lib/cookie";
import { verifyLoginTwoFactorSessionToken } from "@/features/auth/services/login-2fa-session";
import { validateReturnPath } from "@/features/auth/return-intent/return-path";

export async function generateMetadata(): Promise<Metadata> {
  return {
    title: 'LOGIN | Le Fil des Heures',
    description:
      'Le Fil des Heures のログインページです。メールアドレスとパスワード、または Google アカウントでサインインできます。',
    openGraph: {
      title: 'LOGIN | Le Fil des Heures',
      description:
        'Le Fil des Heures のログインページです。メールアドレスとパスワード、または Google アカウントでサインインできます。',
      images: ['/mainphoto.png'],
    },
  };
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  // 検証待ちのまま戻ってきた場合は続きへ送る。ここで資格情報フォームを見せると、
  // もう一度ログインを押して 2 通目の OTP を発射でき、アカウント単位の
  // レート制限（5 回 / 600 秒）を無駄に消費する。
  const cookieStore = await cookies();
  if (
    verifyLoginTwoFactorSessionToken(
      cookieStore.get(loginTwoFactorSessionCookieName)?.value,
    )
  ) {
    redirect("/login/verify");
  }

  const params = await searchParams;
  const tabParam = params?.tab;
  const initialTab = tabParam === 'register' ? 'register' : 'login';
  const emailParam = params?.email;
  const initialEmail = typeof emailParam === 'string' ? emailParam : '';

  const nextParam = params?.next;
  const returnTo = validateReturnPath(nextParam);

  return (
    <AuthTabs
      initialTab={initialTab}
      initialEmail={initialEmail}
      returnTo={returnTo.ok ? returnTo.path : undefined}
    />
  );
}
