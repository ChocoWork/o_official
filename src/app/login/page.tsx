import type { Metadata } from 'next';
import React from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import AuthTabs from "@/components/AuthTabs";
import { loginTwoFactorSessionCookieName } from "@/lib/cookie";
import { verifyLoginTwoFactorSessionToken } from "@/features/auth/services/login-2fa-session";

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

  return <AuthTabs initialTab={initialTab} initialEmail={initialEmail} />;
}
