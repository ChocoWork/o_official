"use client";

import { useEffect } from "react";
import Link from "next/link";
import "./checkout.css";

// checkout の描画中に想定外の例外が起きたときの受け皿（FREQ-358）。
// これが無いと Next.js 既定の全画面エラーになり、カートが残っていることも戻り先も伝わらない。
export default function CheckoutError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  useEffect(() => {
    console.error("[checkout] unexpected render error", error);
  }, [error]);

  return (
    <div className="checkout-page md:px-10 lg:px-12">
      <div className="element-width max-w-2xl">
        <section className="checkout-section checkout-box">
          <div role="alert" className="checkout-section">
            <h1
              className="font-brand"
              style={{ fontSize: "var(--lk-size-lg)", color: "#000" }}
            >
              決済画面を表示できませんでした
            </h1>
            <p style={{ fontSize: "var(--lk-size-sm)", color: "#474747" }}>
              カートの商品はそのまま保持されています。
            </p>
            <p style={{ fontSize: "var(--lk-size-sm)", color: "#474747" }}>
              お手数ですが、もう一度表示するか、カートからお手続きをやり直してください。
            </p>
          </div>
          <div
            className="flex flex-col sm:flex-row"
            style={{ gap: "var(--gap-group)" }}
          >
            <button
              type="button"
              onClick={() => retry()}
              className="px-12 py-4 bg-black text-white lk-text-sm tracking-widest hover:bg-[#474747] transition-all duration-300 cursor-pointer whitespace-nowrap"
            >
              もう一度表示する
            </button>
            <Link
              href="/cart"
              className="px-12 py-4 border border-black text-black text-center lk-text-sm tracking-widest hover:bg-black hover:text-white transition-all duration-300 cursor-pointer whitespace-nowrap"
            >
              カートに戻る
            </Link>
          </div>
        </section>
      </div>
    </div>
  );
}
