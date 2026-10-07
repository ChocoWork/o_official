"use client";

import React, { useId, useState } from "react";
import { Button } from "@/components/ui/Button/Button";
import { LiveMessage } from "@/components/ui/LiveMessage/LiveMessage";
import { TextField } from "@/components/ui/TextField/TextField";
import type { PromotionPreview } from "@/app/checkout/_lib/checkout-api";

/**
 * 入力画面の割引コード（グループ F 設計書第3章）。「適用」でサーバーが確かめ、決済の画面に付けるのは
 * 「確認へ進む」のとき。最終確認画面では変えられない。
 * 画面の関数の外に置く（中で定義すると再描画のたびに作り直され、入力中のコードが消える。FREQ-372）。
 */
export function PromoCodeField({
  applied,
  error,
  disabled = false,
  defaultCode = "",
  onApply,
  onRemove,
}: {
  applied: PromotionPreview | null;
  error: string | null;
  disabled?: boolean;
  defaultCode?: string;
  onApply(code: string): Promise<boolean>;
  onRemove(): void;
}) {
  const inputId = useId();
  const errorId = useId();
  const [code, setCode] = useState(defaultCode);
  const [applying, setApplying] = useState(false);

  const handleApply = async () => {
    const trimmed = code.trim();
    if (!trimmed) return;
    setApplying(true);
    try {
      if (await onApply(trimmed)) {
        setCode("");
      }
    } finally {
      setApplying(false);
    }
  };

  return (
    <div className="checkout-section">
      {/* 見出しを入力欄に結びつける（FREQ-373）。適用済みのときは入力欄が無いので結びつけない */}
      <label className="checkout-label" htmlFor={applied ? undefined : inputId}>
        プロモーションコード
      </label>
      {applied ? (
        <div className="checkout-box flex items-center justify-between" style={{ gap: "var(--gap-group)" }}>
          <span className="checkout-value">{applied.code}</span>
          <Button type="button" variant="text" size="xs" onClick={onRemove} disabled={disabled}>
            削除
          </Button>
        </div>
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
          <Button type="button" size="sm" onClick={handleApply} disabled={disabled || applying || !code.trim()}>
            {applying ? "適用中..." : "適用"}
          </Button>
        </div>
      )}
      {/* 適用できなかった理由（FREQ-374）。入れ物は常に置き、中身だけを入れ替える（LiveMessage） */}
      <LiveMessage id={errorId} className="text-red-600" style={{ fontSize: "var(--lk-size-2xs)" }}>
        {error}
      </LiveMessage>
    </div>
  );
}
