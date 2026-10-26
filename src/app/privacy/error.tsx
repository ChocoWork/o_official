/**
 * プライバシーポリシーの頁の誤りの画面（src/app/privacy/error.tsx）。窓口の案内だけを出す。
 *
 * @packageDocumentation
 * @impl IMPL-PRIVACY-102
 * @design DD-PRIVACY-002
 * @remarks 追跡の設定が読めない時に古い方針を出し続けないため、頁は例外を投げて失敗にしている。その受け皿では方針の本文も委託の一覧も出さず、
 * 利用者が窓口へ辿り着ける案内だけにする。誤りの文・stack は画面にも記録にも出さず、digest だけ残す。
 */

"use client";

import { useEffect } from "react";
import Link from "next/link";

export default function PrivacyError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  const digest = error.digest;

  useEffect(() => {
    console.error("[privacy] render failed", { digest });
  }, [digest]);

  return (
    <div className="w-full max-w-3xl mx-auto">
      <h1 className="mb-10" style={{ fontSize: "var(--lk-size-5xl)" }}>
        プライバシーポリシーを表示できません
      </h1>
      <div role="alert" className="space-y-4 text-[#474747]" style={{ fontSize: "var(--lk-size-xs)", lineHeight: 1.9 }}>
        <p>現在、プライバシーポリシーを表示できません。しばらく時間を置いてから、もう一度お試しください。</p>
        <p>お急ぎの場合は、下記の窓口までご連絡ください。</p>
        <ul>
          <li>お問い合わせ先：privacy@lefildesheures.com</li>
        </ul>
        <p>
          <Link href="/contact" className="underline underline-offset-4 hover:text-black transition-colors">
            お問い合わせフォーム
          </Link>
        </p>
      </div>
      <button
        type="button"
        onClick={() => retry()}
        className="mt-8 px-12 py-4 bg-black text-white lk-text-sm tracking-widest hover:bg-[#474747] transition-all duration-300 cursor-pointer whitespace-nowrap"
      >
        もう一度表示する
      </button>
    </div>
  );
}
