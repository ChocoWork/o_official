"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/Button/Button";
import { LiveMessage } from "@/components/ui/LiveMessage/LiveMessage";
import { clientFetch } from "@/lib/client-fetch";

/**
 * 色 × サイズごとの在庫（FREQ-399）。
 *
 * 在庫は台帳（stock_movements）への追記でしか動かさない。画面は数量と理由を送るだけで、
 * item_variants を直接書き換えない。注文の処理が書く理由（purchase / cancel / refund）は
 * ここからは選べない。
 *
 * 在庫が無い組み合わせも受注生産として売れる（ブランドの前提）。すぐ出せる数が 0 でも「売れない」
 * ではない。すぐ出せる数・引き当て済み・手元の数・受注生産（まだ仕上がっていない数）を並べて置き、
 * 製造と仕入れの判断に使えるようにする（グループ E-1。数え方は DB の関数が1か所で持つ）。
 */

type Variant = {
  id: number;
  colorName: string | null;
  colorHex: string | null;
  sizeLabel: string | null;
  sku: string | null;
  /** すぐ出せる数 */
  stockQuantity: number;
  isActive: boolean;
  /** 引き当て済み: 注文のために取ってある数 */
  committedQuantity: number;
  /** 手元の数: 棚に実際にある数（すぐ出せる数 + 引き当て済み） */
  onHandQuantity: number;
  /** 受注生産: これから作る数 */
  backorderQuantity: number;
};

type Movement = {
  id: number;
  variantId: number;
  delta: number;
  reason: string;
  note: string | null;
  createdAt: string;
  /** 記録した管理者のメール。注文や取消の処理が自動で書いた行は null */
  actorEmail: string | null;
  orderId: string | null;
  /** 注文番号の形（ORD-XXXXXXXX）。注文に結び付かない行は null */
  orderNumber: string | null;
  /** その行で変わった後の、この色・サイズのすぐ出せる数 */
  balanceAfter: number;
};

const REASON_LABELS: Record<string, string> = {
  restock: "入荷",
  adjustment: "棚卸調整",
  purchase: "販売",
  cancel: "取消",
  refund: "返金",
};

// 4つの数の言葉の説明。画面の上に1回だけ書く（色・サイズごとの行には書かない）
const STOCK_TERMS_EXPLANATION =
  "すぐ出せる数は今すぐ売れる数、引き当て済みは注文のために取ってある数、手元の数は棚に実際にある数、受注生産はこれから作る数。";

// 読み込みの失敗は、窓口の英語の文を出さずにこの文にする（店主は英語が読めない）。記録の直後の読み直しの失敗も同じ
const LOAD_ERROR_MESSAGE = "在庫の取得に失敗しました。";

// 管理画面から打てる理由。注文の処理が書くものは含めない（API 側でも拒否する）。
const ADMIN_REASONS = [
  { value: "restock", label: "入荷" },
  { value: "adjustment", label: "棚卸調整" },
] as const;

const SECTION_TITLE_CLASS =
  "border-b border-black/10 pb-2 lk-text-3xs tracking-widest text-black/80 font-acumin";

const FIELD_CLASS =
  "w-full border border-black/20 bg-white px-3 py-2 lk-text-2xs text-black focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-black/40";

function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("ja-JP", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

/** 符号つきで見せる（+3 / -1）。増減の向きが一目で分かるようにする。 */
function formatDelta(delta: number): string {
  return delta > 0 ? `+${delta}` : String(delta);
}

export function ItemStockSection({ itemId }: { itemId: string }) {
  const [variants, setVariants] = useState<Variant[]>([]);
  const [movements, setMovements] = useState<Movement[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pendingVariantId, setPendingVariantId] = useState<number | null>(null);
  const [drafts, setDrafts] = useState<Record<number, { delta: string; reason: string; note: string }>>({});

  const load = useCallback(async () => {
    try {
      const response = await clientFetch(`/api/admin/items/${itemId}/variants`);
      if (!response.ok) {
        setLoadError(LOAD_ERROR_MESSAGE);
        return;
      }
      const json = await response.json().catch(() => null);
      setLoadError(null);
      setVariants((json?.variants ?? []) as Variant[]);
      setMovements((json?.movements ?? []) as Movement[]);
    } catch (error) {
      console.error("Failed to fetch item variants:", error);
      setLoadError(LOAD_ERROR_MESSAGE);
    } finally {
      setIsLoading(false);
    }
  }, [itemId]);

  useEffect(() => {
    load();
  }, [load]);

  const draftOf = (variantId: number) =>
    drafts[variantId] ?? { delta: "", reason: "restock", note: "" };

  const updateDraft = (variantId: number, patch: Partial<{ delta: string; reason: string; note: string }>) => {
    setDrafts((current) => ({ ...current, [variantId]: { ...draftOf(variantId), ...patch } }));
  };

  const submit = async (variant: Variant) => {
    const draft = draftOf(variant.id);
    const delta = Number(draft.delta);

    if (!Number.isInteger(delta) || delta === 0) {
      setActionError("増減は 0 以外の整数で入力してください。");
      return;
    }

    setPendingVariantId(variant.id);
    setActionError(null);
    setNotice(null);

    try {
      const response = await clientFetch(`/api/admin/items/${itemId}/variants`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          variantId: variant.id,
          delta,
          reason: draft.reason,
          note: draft.note.trim() || undefined,
        }),
      });

      if (!response.ok) {
        const json = await response.json().catch(() => null);
        setActionError(json?.error ?? "在庫の記録に失敗しました");
        return;
      }

      updateDraft(variant.id, { delta: "", note: "" });
      setNotice(`${variantLabel(variant)} の在庫を ${formatDelta(delta)} しました。`);
      // 在庫数は台帳の追記結果。画面で足し引きせず、サーバの値を読み直す。
      await load();
    } catch (error) {
      console.error("Failed to record stock movement:", error);
      setActionError("在庫の記録に失敗しました");
    } finally {
      setPendingVariantId(null);
    }
  };

  if (isLoading) {
    return (
      <section className="mt-12">
        <h2 className={SECTION_TITLE_CLASS}>在庫</h2>
        <p className="mt-4 lk-text-2xs text-black/60">読み込み中...</p>
      </section>
    );
  }

  return (
    <section className="mt-12" aria-labelledby="item-stock-heading">
      <h2 id="item-stock-heading" className={SECTION_TITLE_CLASS}>
        在庫
      </h2>

      <p
        data-testid="stock-terms-explanation"
        className="mt-3 lk-text-3xs leading-relaxed text-black/60"
      >
        {STOCK_TERMS_EXPLANATION}
      </p>
      <p className="mt-1 lk-text-3xs leading-relaxed text-black/60">
        すぐ出せる数が 0 でも、受注生産として注文は受け付ける。
        数を動かすと理由つきで台帳に残り、あとから取り消せない。
      </p>

      {/* 記録できたことを読み上げでも知らせる。視線は入力欄に残るため（FREQ-377 と同じ扱い）。 */}
      <LiveMessage politeness="status">{notice}</LiveMessage>

      {loadError && (
        <p role="alert" className="mt-4 lk-text-2xs text-red-600">
          {loadError}
        </p>
      )}

      {actionError && (
        <p role="alert" data-testid="variant-stock-error" className="mt-4 lk-text-2xs text-red-600">
          {actionError}
        </p>
      )}

      {variants.length === 0 && !loadError ? (
        <p className="mt-4 lk-text-2xs text-black/60">
          色とサイズを保存すると、組み合わせがここに並びます。
        </p>
      ) : (
        <ul className="mt-6 flex flex-col gap-4">
          {variants.map((variant) => {
            const draft = draftOf(variant.id);
            const isPending = pendingVariantId === variant.id;

            return (
              <li
                key={variant.id}
                data-testid={`variant-row-${variant.id}`}
                className="border border-black/10 p-4"
              >
                <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
                  <span className="flex items-center gap-2">
                    {variant.colorHex && (
                      <span
                        aria-hidden="true"
                        className="inline-block h-3 w-3 border border-black/20"
                        style={{ backgroundColor: variant.colorHex }}
                      />
                    )}
                    <span data-testid="variant-color" className="lk-text-2xs text-black">
                      {variant.colorName ?? "—"}
                    </span>
                  </span>

                  <span className="lk-text-2xs text-black">
                    <span className="text-black/50">サイズ </span>
                    <span data-testid="variant-size">{variant.sizeLabel ?? "—"}</span>
                  </span>

                  <span className="lk-text-2xs text-black">
                    <span className="text-black/50">すぐ出せる数 </span>
                    <span data-testid="variant-stock" className="font-medium">
                      {variant.stockQuantity}
                    </span>
                  </span>

                  <span className="lk-text-2xs text-black">
                    <span className="text-black/50">引き当て済み </span>
                    <span data-testid="variant-committed">{variant.committedQuantity}</span>
                  </span>

                  <span className="lk-text-2xs text-black">
                    <span className="text-black/50">手元の数 </span>
                    <span data-testid="variant-on-hand">{variant.onHandQuantity}</span>
                  </span>

                  <span className="lk-text-2xs text-black">
                    <span className="text-black/50">受注生産 </span>
                    <span data-testid="variant-backorder">{variant.backorderQuantity}</span>
                  </span>
                </div>

                <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,8rem)_minmax(0,6rem)_minmax(0,1fr)_auto] sm:items-end">
                  <label className="flex flex-col gap-1">
                    <span className="lk-text-3xs tracking-widest text-black/60">理由</span>
                    <select
                      data-testid="variant-reason"
                      className={FIELD_CLASS}
                      value={draft.reason}
                      onChange={(event) => updateDraft(variant.id, { reason: event.target.value })}
                    >
                      {ADMIN_REASONS.map((reason) => (
                        <option key={reason.value} value={reason.value}>
                          {reason.label}
                        </option>
                      ))}
                    </select>
                  </label>

                  <label className="flex flex-col gap-1">
                    <span className="lk-text-3xs tracking-widest text-black/60">増減</span>
                    <input
                      data-testid="variant-delta"
                      className={FIELD_CLASS}
                      type="number"
                      inputMode="numeric"
                      step={1}
                      value={draft.delta}
                      onChange={(event) => updateDraft(variant.id, { delta: event.target.value })}
                      aria-describedby="item-stock-heading"
                    />
                  </label>

                  <label className="flex flex-col gap-1">
                    <span className="lk-text-3xs tracking-widest text-black/60">備考（任意）</span>
                    <input
                      data-testid="variant-note"
                      className={FIELD_CLASS}
                      type="text"
                      maxLength={200}
                      value={draft.note}
                      onChange={(event) => updateDraft(variant.id, { note: event.target.value })}
                    />
                  </label>

                  <Button
                    data-testid="variant-submit"
                    type="button"
                    variant="secondary"
                    disabled={isPending}
                    onClick={() => submit(variant)}
                  >
                    {isPending ? "記録中..." : "記録する"}
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <h3 className="mt-10 lk-text-3xs tracking-widest text-black/60">履歴</h3>
      {movements.length === 0 && !loadError ? (
        <p className="mt-3 lk-text-2xs text-black/60">まだ記録がありません。</p>
      ) : (
        <ul className="mt-3 flex flex-col gap-2">
          {movements.map((movement) => {
            const variant = variants.find((candidate) => candidate.id === movement.variantId);

            return (
              <li
                key={movement.id}
                data-testid="stock-movement-row"
                className="flex flex-wrap items-baseline gap-x-4 gap-y-1 border-b border-black/5 pb-2 lk-text-3xs text-black/70"
              >
                <span data-testid="stock-movement-time">{formatDateTime(movement.createdAt)}</span>
                {variant && (
                  <span data-testid="stock-movement-variant">{variantLabel(variant)}</span>
                )}
                <span data-testid="stock-movement-reason">
                  {REASON_LABELS[movement.reason] ?? movement.reason}
                </span>
                <span data-testid="stock-movement-delta" className="font-medium text-black">
                  {formatDelta(movement.delta)}
                </span>
                <span data-testid="stock-movement-balance">{`変わった後 ${movement.balanceAfter}`}</span>
                {/* 記録した人が空の行は、注文や取消の処理が自動で書いたもの */}
                <span data-testid="stock-movement-actor">{movement.actorEmail ?? "自動"}</span>
                {movement.orderNumber && (
                  <span data-testid="stock-movement-order">{movement.orderNumber}</span>
                )}
                {movement.note && (
                  <span data-testid="stock-movement-note" className="text-black/50">
                    {movement.note}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function variantLabel(variant: Variant): string {
  return [variant.colorName, variant.sizeLabel].filter(Boolean).join(" / ") || "この組み合わせ";
}
