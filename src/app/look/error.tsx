/**
 * LOOK 一覧・詳細の誤りの画面（src/app/look/error.tsx）。公開の LOOK の取り出しが失敗した時の受け皿。
 *
 * @packageDocumentation
 * @impl IMPL-LOOK-150
 * @design DD-LOOK-069
 * @remarks 取り出しの失敗を「LOOK はまだありません」に見せないために、失敗は誤りの画面で知らせる（SEC-LOOK-022）。error.message・stack は DB の文を含みうるので、画面にも記録にも出さず、突き合わせ用の digest だけを残す。
 */
"use client";

import { useEffect } from "react";

export default function LookError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  useEffect(() => {
    console.error("[look] render error", { digest: error.digest });
  }, [error]);

  return (
    <div className="w-full py-20 text-center">
      <div role="alert" className="element-width space-y-3.25">
        <h1 style={{ fontSize: "var(--lk-size-lg)", color: "#000" }}>
          LOOK を読み込めませんでした
        </h1>
        <p style={{ fontSize: "var(--lk-size-sm)", color: "#474747" }}>
          一時的なエラーのため表示できません。しばらくしてからもう一度お試しください。
        </p>
        <button
          type="button"
          onClick={() => retry()}
          className="mt-5 px-12 py-4 bg-black text-white lk-text-sm tracking-widest hover:bg-[#474747] transition-all duration-300 cursor-pointer whitespace-nowrap"
        >
          もう一度表示する
        </button>
      </div>
    </div>
  );
}
