/**
 * パスワード変更の頁（src/app/account/password/page.tsx）。
 *
 * @packageDocumentation
 * @impl IMPL-AUTH-239
 * @design DD-AUTH-042
 * @remarks 画面の本体は PasswordChangeForm（クライアント）。この頁は題と検索に載せない指定だけを持つ薄い入口で、
 * 会員だけの頁なので索引に載せない。ログインの確かめは本体がログインの状態を見て行う（アカウントの頁と同じ）。
 */
import type { Metadata } from 'next';
import { PasswordChangeForm } from './PasswordChangeForm';

export const metadata: Metadata = {
  title: 'PASSWORD | Le Fil des Heures',
  robots: { index: false },
};

export default function PasswordChangePage() {
  return <PasswordChangeForm />;
}
