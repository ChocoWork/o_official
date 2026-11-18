/**
 * 店員の2本の登録のページ（src/app/staff/register/page.tsx）。
 *
 * @packageDocumentation
 * @impl IMPL-AUTH-374
 * @design DD-AUTH-080
 * @remarks サーバーで、このセッションに結んだ窓が開いているかを確かめ（`readStaffRegisterAccess`）、違えば `/login` へ送る。検索に載せない。
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
  if (!access.ok) redirect("/login");
  return <StaffRegisterScreen initialRegistered={access.registered} />;
}
