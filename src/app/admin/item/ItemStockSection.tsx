"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/Button/Button";
import { LiveMessage } from "@/components/ui/LiveMessage/LiveMessage";
import { Dialog } from "@/components/ui/Dialog/Dialog";
import { ALLOCATION_EVENT_LABELS, allocationEventReasonLabel, type AllocationHistoryEvent } from "@/lib/inventory/allocation-types";
import { toOrderNumber } from "@/lib/orders/order-number";
import { clientFetch } from "@/lib/client-fetch";
import { adminLoadFailureMessage } from "@/lib/admin/admin-load-failure";

/**
 * 色 × サイズごとの在庫（FREQ-399）。
 *
 * 在庫は台帳（stock_movements）への追記でしか動かさない。画面は数量と理由を送るだけで、
 * item_variants を直接書き換えない。注文の処理が書く理由（purchase / cancel / refund / return / exchange）は
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
  /** 返金で動いた行の返金の番号。返金に結び付かない行は null（画面には番号を出さず、理由の言葉を変えるのに使う） */
  refundId: string | null;
  /** 返品で動いた行（理由 return・exchange）の返品の番号（uuid）。返品に結び付かない行は null（画面には出さない。見せるのは returnNumber） */
  returnId: string | null;
  /** 返品で動いた行の返品の番号の形（{注文番号}-R{n}）。返品に結び付かない行は null。注文の番号の欄に、注文番号の代わりに出す */
  returnNumber: string | null;
};

const REASON_LABELS: Record<string, string> = {
  restock: "入荷",
  adjustment: "棚卸調整",
  purchase: "注文への確保",
  cancel: "取消",
  refund: "返金",
  return: "返品の受け取り",
  exchange: "交換品への確保",
  allocation_release: "割当の解放",
};

/**
 * 返金に結び付く調整と再確保は、通常の棚卸と注文への確保から言葉を分ける。
 */
function movementReasonLabel(movement: Movement): string {
  if (movement.refundId && movement.reason === "adjustment") return "棚卸調整（返金で在庫に戻さない）";
  if (movement.refundId && movement.reason === "purchase") return "注文への確保（返金の失敗で再割当）";
  return REASON_LABELS[movement.reason] ?? movement.reason;
}

// 4つの数の言葉の説明。画面の上に1回だけ書く（色・サイズごとの行には書かない）
const STOCK_TERMS_EXPLANATION =
  "すぐ出せる数は今すぐ売れる数、引き当て済みは注文のために取ってある数、手元の数は棚に実際にある数、受注生産はこれから作る数。";

// 読み込みの失敗は、窓口の英語の文を出さずにこの文にする（店主は英語が読めない）。記録の直後の読み直しの失敗も同じ
const LOAD_ERROR_MESSAGE = "在庫の取得に失敗しました。";
// 窓口が 403 を返した時（admin.stock.read / admin.stock.manage が無い）は、英語の Forbidden を出さずにこの文にする
const READ_FORBIDDEN_MESSAGE = "在庫を見る権限がありません。";
const WRITE_FORBIDDEN_MESSAGE = "在庫を変更する権限がありません。";
// 変更の窓口の CSRF の確かめで断られた 403（権限の不足ではない）。他の管理画面と同じ「再読み込みして、もう一度」の文
const WRITE_CSRF_MESSAGE = "セキュリティ確認に失敗しました。ページを再読み込みして、もう一度記録してください。";
const WRITE_FAILED_MESSAGE = "在庫の記録に失敗しました";

/**
 * 記録の POST が失敗した時の文。403 は本文の reason を先に見る（CSRF の失敗と MFA なしの 403 を「権限なし」と出さない）。
 * 本物の権限の 403（reason なし・DB の GROUP_G_FORBIDDEN）だけ権限の文。403 以外は窓口の日本語の文をそのまま出す。
 */
function writeFailureMessage(status: number, json: unknown): string {
  const body = (typeof json === "object" && json !== null ? json : {}) as { reason?: unknown; error?: unknown };
  if (status === 403 && body.reason === "CSRF validation failed") return WRITE_CSRF_MESSAGE;
  if (status === 403) return adminLoadFailureMessage(status, body, WRITE_FORBIDDEN_MESSAGE, WRITE_FAILED_MESSAGE);
  return typeof body.error === "string" && body.error ? body.error : WRITE_FAILED_MESSAGE;
}

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
  const [allocationEvents, setAllocationEvents] = useState<AllocationHistoryEvent[]>([]);
  const [confirmation, setConfirmation] = useState<{ variant: Variant; delta: number; reason: string; quantity: number; note: string } | null>(null);
  const sending = useRef(false);
  const retries = useRef(new Map<number, { signature: string; body: string }>());
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
      const json = await response.json().catch(() => null);
      if (!response.ok) {
        // MFA なしの 403 を「権限がありません」と誤って出さない（本文の reason を先に見る）
        setLoadError(adminLoadFailureMessage(response.status, json, READ_FORBIDDEN_MESSAGE, LOAD_ERROR_MESSAGE));
        return;
      }
      setLoadError(null);
      setVariants((json?.variants ?? []) as Variant[]);
      setMovements((json?.movements ?? []) as Movement[]);
      setAllocationEvents((json?.allocationEvents ?? []) as AllocationHistoryEvent[]);
    } catch {
      console.error("Failed to fetch item variants");
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

  const send = async (variant: Variant, delta: number, reason: string, note: string, expectedReleaseQuantity?: number) => {
    if (sending.current) return;
    if (expectedReleaseQuantity !== undefined && !note.trim()) {
      setActionError("割り当てを外す理由を入力してください。");
      return;
    }
    const payload = { variantId: variant.id, delta, reason, note: note.trim() || undefined, expectedReleaseQuantity };
    const signature = JSON.stringify(payload);
    // Retain the exact accepted body/key until a definite response or an edit changes the intent.
    let retry = retries.current.get(variant.id);
    if (retry?.signature !== signature) {
      retry = { signature, body: JSON.stringify({ ...payload, requestKey: crypto.randomUUID() }) };
      retries.current.set(variant.id, retry);
    }
    sending.current = true;
    setPendingVariantId(variant.id);
    setActionError(null);
    setNotice(null);
    try {
      const response = await clientFetch(`/api/admin/items/${itemId}/variants`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: retry.body,
      });
      if (!response.ok) {
        const json = await response.json().catch(() => null);
        if (response.status === 409 && json?.code === "GROUP_G_STOCK_RELEASE_CONFIRMATION_REQUIRED"
          && Number.isInteger(json.releasedQuantity) && json.releasedQuantity >= 0 && json.releasedQuantity <= 2147483647) {
          retries.current.delete(variant.id);
          setConfirmation({ variant, delta, reason, quantity: json.releasedQuantity, note });
        } else {
          if (response.status < 500) retries.current.delete(variant.id);
          setActionError(writeFailureMessage(response.status, json));
        }
        return;
      }
      retries.current.delete(variant.id);
      setConfirmation(null);
      updateDraft(variant.id, { delta: "", note: "" });
      setNotice(`${variantLabel(variant)} の在庫を ${formatDelta(delta)} しました。`);
      await load();
    } catch {
      setActionError(WRITE_FAILED_MESSAGE);
    } finally {
      sending.current = false;
      setPendingVariantId(null);
    }
  };
  const submit = async (variant: Variant) => {
    const draft = draftOf(variant.id);
    const delta = Number(draft.delta);
    if (!Number.isInteger(delta) || delta === 0 || delta < -2147483648 || delta > 2147483647) {
      setActionError("増減は 0 以外の整数で入力してください。");
      return;
    }
    await send(variant, delta, draft.reason, draft.note);
  };

  const history = [
    ...movements.map((movement) => ({ kind: 'movement' as const, id: String(movement.id), createdAt: movement.createdAt, movement })),
    ...allocationEvents.filter((event) => event.stockMovementId === null)
      .map((event) => ({ kind: 'event' as const, id: event.id, createdAt: event.createdAt, event })),
  ].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)
    || (a.kind === 'movement' && b.kind === 'movement' ? Number(b.id) - Number(a.id) : b.id.localeCompare(a.id)));

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

      {actionError && !confirmation && (
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
            const disabled = pendingVariantId !== null || confirmation !== null;

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

                  {/* 商品から外した色・サイズの組み合わせ。隠さずに出す（在庫が残っていると合計を見誤るため。FREQ-517） */}
                  {!variant.isActive && (
                    <span data-testid="variant-retired" className="lk-text-2xs text-black/60">
                      止めた
                    </span>
                  )}

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
                      disabled={disabled}
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
                      disabled={disabled}
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
                      disabled={disabled}
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
                    disabled={disabled}
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
      {history.length === 0 && !loadError ? (
        <p className="mt-3 lk-text-2xs text-black/60">まだ記録がありません。</p>
      ) : (
        <ul className="mt-3 flex flex-col gap-2">
          {history.map((entry) => {
            if (entry.kind === 'event') {
              const event = entry.event;
              const variant = variants.find((candidate) => candidate.id === event.variantId);
              return <li key={`event-${event.id}`} data-testid={`allocation-event-${event.id}`}
                className="flex flex-wrap items-baseline gap-x-4 gap-y-1 border-b border-black/5 pb-2 lk-text-3xs text-black/70">
                <span>{formatDateTime(event.createdAt)}</span>
                {variant && <span>{variantLabel(variant)}</span>}
                <span>{ALLOCATION_EVENT_LABELS[event.type]}</span>
                <span>{`割当 ${event.quantity}点`}</span>
                <span data-testid="allocation-event-delta">—</span>
                <span data-testid="allocation-event-balance">—</span>
                <span>{event.actorId === null ? "自動処理" : "管理者"}</span>
                <span>{toOrderNumber(event.orderId)}</span>
                {event.reason && <span data-testid="allocation-event-reason">{allocationEventReasonLabel(event.reason)}</span>}
              </li>;
            }
            const movement = entry.movement;
            const variant = variants.find((candidate) => candidate.id === movement.variantId);

            return (
              <li
                key={`movement-${movement.id}`}
                data-testid="stock-movement-row"
                className="flex flex-wrap items-baseline gap-x-4 gap-y-1 border-b border-black/5 pb-2 lk-text-3xs text-black/70"
              >
                <span data-testid="stock-movement-time">{formatDateTime(movement.createdAt)}</span>
                {variant && (
                  <span data-testid="stock-movement-variant">{variantLabel(variant)}</span>
                )}
                <span data-testid="stock-movement-reason">
                  {movementReasonLabel(movement)}
                </span>
                <span data-testid="stock-movement-delta" className="font-medium text-black">
                  {formatDelta(movement.delta)}
                </span>
                <span data-testid="stock-movement-balance">{`変わった後 ${movement.balanceAfter}`}</span>
                {/* 記録した人が空の行は、注文や取消の処理が自動で書いたもの */}
                <span data-testid="stock-movement-actor">{movement.actorEmail ?? "自動処理"}</span>
                {/* 返品で動いた行は、注文番号の代わりに返品の番号（{注文番号}-R{n}）を出す。どの注文のどの返品かが分かる */}
                {(movement.returnNumber ?? movement.orderNumber) && (
                  <span data-testid="stock-movement-order">{movement.returnNumber ?? movement.orderNumber}</span>
                )}
                {allocationEvents.filter((event) => event.stockMovementId === String(movement.id)).map((event) => (
                  <span key={event.id} data-allocation-event={event.id}>{ALLOCATION_EVENT_LABELS[event.type]}</span>
                ))}
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
      <Dialog open={confirmation !== null} title="在庫を減らす"
        description={confirmation ? `割り当て済みの品を${confirmation.quantity}点外し、受注生産中に戻します。` : undefined}
        onClose={() => { if (!sending.current) { if (confirmation) retries.current.delete(confirmation.variant.id); setConfirmation(null); setActionError(null); } }}>
        {confirmation && <>
          <label className="flex flex-col gap-1">
            <span>割り当てを外す理由</span>
            <input className={FIELD_CLASS} maxLength={200} disabled={pendingVariantId !== null}
              value={confirmation.note} onChange={(event) => setConfirmation({ ...confirmation, note: event.target.value })} />
          </label>
          {actionError && <p role="alert" className="text-red-600">{actionError}</p>}
          <div className="mt-4 flex gap-3">
            <Button type="button" variant="secondary" disabled={pendingVariantId !== null}
              onClick={() => { if (!sending.current) { retries.current.delete(confirmation.variant.id); setConfirmation(null); setActionError(null); } }}>戻る</Button>
            <Button type="button" disabled={pendingVariantId !== null}
              onClick={() => send(confirmation.variant, confirmation.delta, confirmation.reason, confirmation.note, confirmation.quantity)}>在庫を減らす</Button>
          </div>
        </>}
      </Dialog>
    </section>
  );
}

function variantLabel(variant: Variant): string {
  return [variant.colorName, variant.sizeLabel].filter(Boolean).join(" / ") || "この組み合わせ";
}
