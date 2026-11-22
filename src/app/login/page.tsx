/**
 * ログインの画面（src/app/login/page.tsx）。パスキー・Google・メールのコードの3つの入口を並べる。
 *
 * @packageDocumentation
 * @impl IMPL-AUTH-324
 * @design DD-AUTH-001
 * @remarks メールのコードの保留の Cookie が有効なら、描く前にサーバーで続き（`/login/code`）へ転送する。入力の途中で戻ってきた人にもう一度フォームを見せると、2通目のコードを送って枠を無駄に使う。
 * 問い合わせは `next`（確かめを通った道筋だけ。外れた値は捨てる）・`email`（メール欄の初めの値。`tab` は読まない）・
 * `error=staff_passkey_required`（Google で店員がフックに断られた戻り先）だけを固定の文にして出し、ほかの `error` の値は出さない（DD-AUTH-083）。
 * 旧のパスワードのログインの保留の Cookie は見ない（名前を知らない Cookie として無視する。ADR-0469）。
 */
import type { Metadata } from 'next';
import React from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { emailCodeSessionCookieName } from "@/lib/cookie";
import { verifyEmailCodeSessionToken } from "@/features/auth/services/email-code-session";
import { validateReturnPath } from "@/features/auth/return-intent/return-path";
import LoginChoices from "@/features/auth/passkey/components/LoginChoices";
import { staffPasskeyRequiredMessage } from "@/features/auth/passkey/staff-passkey-message";

const IDLE_NOTICE = 'しばらく操作がなかったため、ログアウトしました。もう一度ログインしてください。';

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

  const params = await searchParams;
  const emailParam = params?.email;
  const initialEmail = typeof emailParam === 'string' ? emailParam : '';
  const returnTo = validateReturnPath(params?.next);

  return (
    <LoginChoices
      initialEmail={initialEmail}
      returnTo={returnTo.ok ? returnTo.path : undefined}
      errorMessage={params?.error === 'staff_passkey_required' ? staffPasskeyRequiredMessage() : undefined}
      notice={params?.reason === 'idle' ? IDLE_NOTICE : undefined}
    />
  );
}
