/**
 * 店員の2本の登録のページ（src/app/staff/register/page.tsx）。
 *
 * @packageDocumentation
 * @impl IMPL-AUTH-374
 * @design DD-AUTH-080
 * @remarks サーバーで、このセッションに結んだ窓が開いているかを確かめ（`readStaffRegisterAccess`）、違えば `/login` へ送る（DB が読めない時は送らず「しばらくしてからお試しください。」を出す）。検索に載せない。
 */
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import StaffRegisterScreen from "@/features/auth/staff/components/StaffRegisterScreen";
import { readStaffRegisterAccess } from "@/features/auth/staff/staff-register-access";

export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

export default async function StaffRegisterPage() {
  const access = await readStaffRegisterAccess();
  if (!access.ok) {
    if (access.unavailable) {
      return (
        <main className="mx-auto w-full max-w-2xl px-6 py-16">
          <p role="alert">しばらくしてからお試しください。</p>
        </main>
      );
    }
    redirect("/login");
  }
  return <StaffRegisterScreen initialRegistered={access.registered} />;
}
