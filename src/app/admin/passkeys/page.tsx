/**
 * 店員のパスキー管理のページ（src/app/admin/passkeys/page.tsx）。
 *
 * @packageDocumentation
 * @impl IMPL-AUTH-384
 * @design DD-AUTH-082
 * @remarks サーバーで入口の条件（有効な店員の役割・パスキーのログインから24時間・無操作1時間。認めた鍵の本数は求めない）を確かめ、外れたら `/login`（`reason` つき）へ送る。
 * 確かめが読めない時は `/login` へ送らず「しばらくしてからお試しください。」を出す。`/auth/verified` へは送り返さない（そこが1本の店員をここへ送るので、回り続ける）。
 * `?more=1` で、認めた鍵が2本未満なら「もう1本」の画面、それ以外は管理の画面。検索に載せない。
 */
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import StaffOneMoreKey from "@/features/auth/staff/components/StaffOneMoreKey";
import StaffPasskeyManager from "@/features/auth/staff/components/StaffPasskeyManager";
import { requireStaffPasskeyPage } from "@/lib/auth/staff-passkey-page-guard";

export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

const MIN_APPROVED = 2;

export default async function StaffPasskeysPage({ searchParams }: { searchParams: Promise<{ more?: string | string[] }> }) {
  const access = await requireStaffPasskeyPage();
  if (!access.ok) {
    if ("unavailable" in access) {
      return (
        <main className="mx-auto w-full max-w-2xl px-6 py-16">
          <p role="alert">しばらくしてからお試しください。</p>
        </main>
      );
    }
    redirect(access.redirectTo);
  }
  const { more } = await searchParams;
  if (more === "1" && access.approvedCount < MIN_APPROVED) return <StaffOneMoreKey />;
  return (
    <main>
      <StaffPasskeyManager />
    </main>
  );
}
