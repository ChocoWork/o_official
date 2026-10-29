"use client";

import React, { useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/Button/Button";
import { LiveMessage } from "@/components/ui/LiveMessage/LiveMessage";
import { TextField } from "@/components/ui/TextField/TextField";
import { BETTER_DISCOUNT_MESSAGE, GUEST_DISCOUNT_REFUSAL_MESSAGE } from "@/lib/discounts/discount-messages";
import { MAX_DISCOUNT_CODES } from "@/lib/discounts/discount-types";

export const PROMOTION_CODE_LIMIT_MESSAGE = `コードは${MAX_DISCOUNT_CODES}つまで入力できます。`;
/** ゲストの全拒否の案内先。コードやメールは URL に入れない。 */
const LOGIN_HREF = "/login?next=%2Fcheckout";

export type PromoCodeFieldProps = {
  /** 入力済みで有効なコード（適用されたものと、未採用のもの）。最大5つ */
  codes: readonly string[];
  onApply(code: string): Promise<void>;
  /** 該当コードだけを外す。ほかのコードは残し、サーバーで再計算する */
  onRemove(code: string): Promise<void>;
  /** 適用できなかった理由。入れ物は常に置く */
  error: string | null;
  /** 確認の通信中（親が立てる）。適用・削除を押せなくする */
  busy: boolean;
  /** 有効だが、よりお得な割引があるため採用されなかったコード */
  unusedCodes: readonly string[];
  buyerKind: "member" | "guest";
  /** 確定無効になったコードを欄に戻して理由と並べる（再入場・確認画面からの戻り） */
  defaultCode?: string;
};

/**
 * 入力画面の割引コード（グループ F 設計書第3章、グループ H）。最大5つ。「適用」でサーバーが全コードを確かめ、
 * 決済の画面に付けるのは「確認へ進む」のとき。最終確認画面では変えられない。
 * 画面の関数の外に置く（中で定義すると再描画のたびに作り直され、入力中のコードが消える。FREQ-372）。
 */
export function PromoCodeField({
  codes,
  onApply,
  onRemove,
  error,
  busy,
  unusedCodes,
  buyerKind,
  defaultCode = "",
}: PromoCodeFieldProps) {
  const inputId = useId();
  const errorId = useId();
  const [code, setCode] = useState(defaultCode);
  const [applying, setApplying] = useState(false);
  const submittedRef = useRef(false);
  const modeRef = useRef<"apply" | "remove">("apply");
  const sawBusyRef = useRef(false);
  const full = codes.length >= MAX_DISCOUNT_CODES;

  // 「適用」の通信が終わったら、通ったときは欄を空に、通らなかったときは入力を残して欄へフォーカスを戻す
  useEffect(() => {
    if (busy) {
      sawBusyRef.current = true;
      return;
    }
    if (!submittedRef.current || !sawBusyRef.current) return;
    submittedRef.current = false;
    sawBusyRef.current = false;
    // 削除の後は、押したボタンの行が消えてフォーカスを失うので、入力欄へ移す
    if (error || modeRef.current === "remove") {
      document.getElementById(inputId)?.focus();
    } else {
      setCode("");
    }
  }, [busy, error, inputId]);

  const handleApply = async () => {
    const trimmed = code.trim();
    if (!trimmed || busy) return;
    submittedRef.current = true;
    modeRef.current = "apply";
    sawBusyRef.current = false;
    setApplying(true);
    try {
      await onApply(trimmed);
    } finally {
      setApplying(false);
      // 親が busy を立てなかった（5つの上限など）ときは、次の通信を自分の「適用」と取り違えない
      if (!sawBusyRef.current) submittedRef.current = false;
    }
  };

  const handleRemove = async (target: string) => {
    if (busy) return;
    submittedRef.current = true;
    modeRef.current = "remove";
    sawBusyRef.current = false;
    try {
      await onRemove(target);
    } finally {
      if (!sawBusyRef.current) submittedRef.current = false;
    }
  };

  const showGuestLogin = buyerKind === "guest" && error === GUEST_DISCOUNT_REFUSAL_MESSAGE;

  return (
    <div className="checkout-section">
      {/* 見出しを入力欄に結びつける（FREQ-373）。5つ入力済みで入力欄が無いときは結びつけない */}
      <label className="checkout-label" htmlFor={full ? undefined : inputId}>
        プロモーションコード
      </label>

      {codes.length > 0 ? (
        <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: "var(--gap-tight, 0.25rem)" }}>
          {codes.map((applied) => (
            <li key={applied} className="checkout-box flex items-center justify-between" style={{ gap: "var(--gap-group)" }}>
              <span className="checkout-value" style={{ minWidth: 0, overflowWrap: "anywhere" }}>{applied}</span>
              <Button
                type="button"
                variant="text"
                size="xs"
                aria-label={`${applied}を削除`}
                onClick={() => void handleRemove(applied)}
                disabled={busy}
              >
                削除
              </Button>
            </li>
          ))}
        </ul>
      ) : null}

      {unusedCodes.length > 0 ? (
        <ul style={{ listStyle: "none", margin: 0, padding: 0, fontSize: "var(--lk-size-2xs)", color: "#474747" }}>
          {unusedCodes.map((unused) => (
            <li key={unused} style={{ overflowWrap: "anywhere" }}>
              {unused}：{BETTER_DISCOUNT_MESSAGE}
            </li>
          ))}
        </ul>
      ) : null}

      {full ? (
        <p style={{ fontSize: "var(--lk-size-2xs)", color: "#474747" }}>{PROMOTION_CODE_LIMIT_MESSAGE}</p>
      ) : (
        <div className="checkout-promo">
          <div className="checkout-promo-field">
            <TextField
              id={inputId}
              placeholder="コードを入力"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              size="sm"
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? errorId : undefined}
            />
          </div>
          <Button type="button" size="sm" onClick={handleApply} disabled={busy || !code.trim()}>
            {applying ? "適用中..." : "適用"}
          </Button>
        </div>
      )}

      {/* 適用できなかった理由（FREQ-374）。入れ物は常に置き、中身だけを入れ替える（LiveMessage） */}
      <LiveMessage id={errorId} className="text-red-600" style={{ fontSize: "var(--lk-size-2xs)" }}>
        {error}
      </LiveMessage>
      {showGuestLogin ? (
        <Link href={LOGIN_HREF} className="underline" style={{ fontSize: "var(--lk-size-2xs)" }}>
          ログインして割引を確かめる
        </Link>
      ) : null}
    </div>
  );
}
