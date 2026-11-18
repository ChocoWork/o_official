/**
 * 店員の招待のリンクのページ（src/app/staff/invite/page.tsx）。
 *
 * @packageDocumentation
 * @impl IMPL-AUTH-367
 * @design DD-AUTH-078
 * @remarks 合言葉は URL の `#` にあり、サーバーには届かない。画面の部品が読んで消す。検索に載せない。
 */
import type { Metadata } from "next";
import StaffInviteScreen from "@/features/auth/staff/components/StaffInviteScreen";

export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

export default function StaffInvitePage() {
  return <StaffInviteScreen />;
}
