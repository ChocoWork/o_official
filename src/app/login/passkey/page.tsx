/**
 * パスキーを作る勧めのページ（src/app/login/passkey/page.tsx）。
 *
 * @packageDocumentation
 * @impl IMPL-AUTH-327
 * @design DD-AUTH-064
 * @remarks メールのコードでログインした後に、コードの入力画面から移ってくる。ログインしているかどうかは、描いた後に部品が確かめる
 * （ログインの状態はブラウザの Cookie とアプリの状態を使うため）。検索に載せない。
 */
import type { Metadata } from "next";
import PasskeyOffer from "@/features/auth/passkey/components/PasskeyOffer";

export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

export default function LoginPasskeyPage() {
  return <PasskeyOffer />;
}
