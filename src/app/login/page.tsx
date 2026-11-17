/**
 * ログインの画面（src/app/login/page.tsx）。パスキー・Google・メールのコードの3つの入口を並べる。
 *
 * @packageDocumentation
 * @impl IMPL-AUTH-324
 * @design DD-AUTH-001
 * @remarks 新旧どちらかの保留の Cookie が有効なら、描く前にサーバーで続きへ転送する
 * （新→`/login/code`、旧→`/login/verify`）。入力の途中で戻ってきた人にもう一度フォームを見せると、2通目のコードを送って枠を無駄に使う。
 * 問い合わせは `next`（確かめを通った道筋だけ。外れた値は捨てる）・`email`（メール欄の初めの値。`tab` は読まない）・
 * `registered=1`（確認のリンクを別のブラウザで開いた人への固定の案内。SEC-AUTH-007）だけを受ける。
 * パスワードの旧い画面は `/login/password` に残してある（段4まで。ADR-0469）。
 */
import type { Metadata } from 'next';
import React from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { emailCodeSessionCookieName, loginTwoFactorSessionCookieName } from "@/lib/cookie";
import { verifyEmailCodeSessionToken } from "@/features/auth/services/email-code-session";
import { verifyLoginTwoFactorSessionToken } from "@/features/auth/services/login-2fa-session";
import { validateReturnPath } from "@/features/auth/return-intent/return-path";
import LoginChoices from "@/features/auth/passkey/components/LoginChoices";

/** 確認のメールのリンクは session を作らずここへ送る（SEC-AUTH-007）。 */
const REGISTERED_NOTICE = '会員登録が完了しました。ログインしてください。';

const DESCRIPTION =
  'Le Fil des Heures のログインページです。パスキー、Google アカウント、メールで受け取るコードでサインインできます。';

export async function generateMetadata(): Promise<Metadata> {
  return {
    title: 'LOGIN | Le Fil des Heures',
    description: DESCRIPTION,
    openGraph: {
      title: 'LOGIN | Le Fil des Heures',
      description: DESCRIPTION,
      images: ['/mainphoto.png'],
    },
  };
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const cookieStore = await cookies();
  if (verifyEmailCodeSessionToken(cookieStore.get(emailCodeSessionCookieName)?.value)) {
    redirect("/login/code");
  }
  if (verifyLoginTwoFactorSessionToken(cookieStore.get(loginTwoFactorSessionCookieName)?.value)) {
    redirect("/login/verify");
  }

  const params = await searchParams;
  const emailParam = params?.email;
  const initialEmail = typeof emailParam === 'string' ? emailParam : '';
  const returnTo = validateReturnPath(params?.next);

  return (
    <LoginChoices
      initialEmail={initialEmail}
      returnTo={returnTo.ok ? returnTo.path : undefined}
      notice={params?.registered === '1' ? REGISTERED_NOTICE : undefined}
    />
  );
}
