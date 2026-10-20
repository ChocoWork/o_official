'use client';

import type { ReactNode } from 'react';
import { Button } from '@/components/ui/Button/Button';
import { Dialog } from '@/components/ui/Dialog/Dialog';
import type { ReturnLoadState } from '@/hooks/useLoadedReturn';
import type { useReturnOperation } from '@/hooks/useReturnOperation';
import { clampQuantity } from '@/lib/orders/fulfillment/fulfillment-client';
import { formatYen } from '@/lib/orders/refund/refund-messages';
import type { OrderReturnLineDetail } from '@/lib/orders/returns/return-types';

/** 返品の操作の画面（受け取り・額を決めて返金・検品・取消・開き直し・手数料・支払いを待たずに送る）が、7つとも受ける props */
export type ReturnDialogProps = {
  /** 返品の中身は、この注文の GET /api/admin/orders/{orderId}/returns を自分で読んで、returnId の返品を探す */
  orderId: string;
  /** 操作する返品 */
  returnId: string;
  /** 閉じる（戻る・Esc・背景）。何も確定していない閉じ方 */
  onClose: () => void;
  /**
   * 操作が受け付けられた（同じ二重防止の番号の送り直しで前の結果が返った時も）。notice は返品の欄に出す知らせ（C-5 の後の知らせ）。
   * 閉じるのは親（onDone の後に画面を外す）。省いてよい
   */
  onDone: (notice?: string) => void;
  /**
   * 送信を試みた後、成功を確かめられないまま閉じる時に、onClose の前に呼ぶ（答えが分からない・窓口に断られた）。
   * 返金や記録が行われたかもしれない（受け取りだけ記録されて返金が断られた時など）ので、親が一覧を読み直す
   */
  onUncertain?: () => void;
};

type ReturnLoadDialogProps = {
  state: Exclude<ReturnLoadState, { kind: 'ready' }>;
  /** 読み終える前の画面の題。読み終えたら、画面ごとの題（返品の番号つきのことがある）に替わる */
  title: string;
  onClose: () => void;
};

/** 返品の中身を読んでいる間と、読めなかった時の画面。後者は理由と「閉じる」だけを出す（E-2 の返金の画面の材料を読めない時と同じ） */
export function ReturnLoadDialog({ state, title, onClose }: ReturnLoadDialogProps) {
  return (
    <Dialog open onClose={onClose} title={title} fullScreenOnMobile>
      <div className="space-y-3">
        {state.kind === 'loading' ? (
          <p className="font-acumin lk-text-3xs text-[#474747]">読み込み中です...</p>
        ) : (
          <p role="alert" className="font-acumin lk-text-3xs text-red-700">
            {state.message}
          </p>
        )}
        <div className="flex gap-2 pt-1">
          <Button variant="secondary" size="sm" className="w-full font-acumin" onClick={onClose}>
            閉じる
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

type ReturnFlowContentProps = {
  flow: Pick<ReturnType<typeof useReturnOperation>, 'alertText' | 'busy' | 'uncertain' | 'recorded' | 'close' | 'checkAgain'>;
  /** 戻るのボタンの言葉 */
  backLabel: string;
  /** 戻るを押した時の動き。省くと画面を閉じる（確かめの手前の画面へ戻る時に渡す） */
  onBack?: () => void;
  submitLabel: string;
  canSubmit: boolean;
  /** 確定と戻るの間（見た目は確定の下、戻るの上）に出す、もう1つの操作。手数料の「いただかないで終える」。省ける */
  extraAction?: {
    label: string;
    onClick: () => void;
    /** 省くと確定と同じく canSubmit に従う。お断りのように、確定が押せなくても押せる操作に付ける */
    disabled?: boolean;
  };
  children: ReactNode;
};

/**
 * 返品の画面の、入力の下の部分（誤りの文と下のボタン）を揃える（E-2 の RefundFlowContent と同じ並び）。
 * 答えが分からない時は、ボタンを「閉じる」と「もう一度確かめる」だけにする（extraAction も出さない）。
 */
export function ReturnFlowContent({ flow, backLabel, onBack, submitLabel, canSubmit, extraAction, children }: ReturnFlowContentProps) {
  return (
    <>
      {children}

      {flow.alertText ? (
        <p role="alert" className="font-acumin lk-text-3xs text-red-700">
          {flow.alertText}
        </p>
      ) : null}

      {flow.recorded ? (
        // 受け取りは記録済みで返金だけ断られた。もう送らず閉じるだけ
        <div className="flex gap-2 pt-1">
          <Button variant="secondary" size="sm" className="w-full font-acumin" onClick={flow.close}>閉じる</Button>
        </div>
      ) : flow.uncertain ? (
        <div className="flex gap-2 pt-1">
          <Button variant="secondary" size="sm" className="w-full font-acumin" disabled={flow.busy} onClick={flow.close}>
            閉じる
          </Button>
          <Button variant="primary" size="sm" className="w-full font-acumin" disabled={flow.busy} onClick={flow.checkAgain}>
            もう一度確かめる
          </Button>
        </div>
      ) : (
        // 確定のボタンの字は「すべて受け取って ￥24,000 を返金する、交換の品を発送待ちにする」のように長いので、縦に並べて確定を
        // 1行の全部の幅にする（見た目は確定が上。並びの順は戻る → 確定のまま）。収まらない時の折り返しは globals.css が許す。
        // extraAction は戻ると確定の間に置く（見た目は 確定 → extraAction → 戻る の順。手数料の画面の「いただかないで終える」）
        <div className="refund-flow-actions flex flex-col-reverse gap-2 pt-1">
          <Button variant="secondary" size="sm" className="w-full font-acumin" disabled={flow.busy} onClick={onBack ?? flow.close}>
            {backLabel}
          </Button>
          {extraAction ? (
            <Button variant="secondary" size="sm" className="w-full font-acumin" disabled={extraAction.disabled ?? !canSubmit} onClick={extraAction.onClick}>
              {extraAction.label}
            </Button>
          ) : null}
          <Button type="submit" variant="primary" size="sm" className="w-full font-acumin" disabled={!canSubmit}>
            {submitLabel}
          </Button>
        </div>
      )}
    </>
  );
}

/**
 * 申し込みの間の行に出す、お客様のご希望の文（C-5）。申し込みの間の解決は仮の値（お客様のご希望と同じ）なので、
 * 承認の時にお店が決める解決とは分けて「ご希望」として出す。ご希望の記録が無い行（お店が作った返品）は null
 */
export function requestedWishText(line: Pick<OrderReturnLineDetail, 'requestedResolution' | 'requestedExchange'>): string | null {
  if (line.requestedResolution === null) return null;
  if (line.requestedResolution === 'refund') return 'ご希望: 返金';
  const target = line.requestedExchange
    ? [line.requestedExchange.color, line.requestedExchange.size].filter((part): part is string => Boolean(part)).join(' / ')
    : '';
  return target ? `ご希望: 交換（${target}）` : 'ご希望: 交換';
}

type ReturnNumberInputProps = {
  id: string;
  label: string;
  value: number;
  max: number;
  disabled: boolean;
  onChange: (next: number) => void;
};

function ReturnNumberInput({ id, label, value, max, disabled, onChange }: ReturnNumberInputProps) {
  return (
    <div>
      <label htmlFor={id} className="block font-acumin lk-text-3xs text-[#474747]">
        {label}
      </label>
      <input
        id={id}
        type="number"
        inputMode="numeric"
        min={0}
        max={max}
        step={1}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(clampQuantity(event.target.value, max))}
        className="mt-1 h-9 w-full border border-[#d4d4d4] bg-white px-2 font-acumin lk-text-3xs text-black disabled:bg-[#f3f3f3]"
      />
    </div>
  );
}

type ReturnRefundFieldsProps = {
  /** 入力の id の頭（受け取りの画面と、額を決めて返金の画面で分ける） */
  idPrefix: string;
  /** 内訳の行 [見出し, 金額の文字]。上から並べる */
  rows: Array<[string, string]>;
  /** 内訳の直下の補足。受け取りのお支払い待ちの見込みに使う。省ける */
  afterBreakdown?: ReactNode;
  amount: number;
  refundableAmount: number;
  onAmountChange: (next: number) => void;
  shippingAmount: number;
  refundableShipping: number;
  onShippingChange: (next: number) => void;
  disabled: boolean;
};

/** 受け取りの画面（今返金）と額を決めて返金の画面が共有する、返金の内訳と、返金額・送料の入力（設計書 6-1・6-3） */
export function ReturnRefundFields({
  idPrefix,
  rows,
  afterBreakdown,
  amount,
  refundableAmount,
  onAmountChange,
  shippingAmount,
  refundableShipping,
  onShippingChange,
  disabled,
}: ReturnRefundFieldsProps) {
  return (
    <div className="space-y-3">
      <div role="group" aria-label="返金の内訳" className="border-t border-[#d4d4d4] pt-3">
        <dl className="space-y-1">
          {rows.map(([term, value]) => (
            <div key={term} className="flex justify-between font-acumin lk-text-sm text-black">
              <dt>{term}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      </div>
      {afterBreakdown}
      <ReturnNumberInput
        id={`${idPrefix}-amount`}
        label={`返金額（返せる額: ${formatYen(refundableAmount)}）`}
        value={amount}
        max={refundableAmount}
        disabled={disabled}
        onChange={onAmountChange}
      />
      <ReturnNumberInput
        id={`${idPrefix}-shipping`}
        label={`送料（返せる送料: ${formatYen(refundableShipping)}）`}
        value={shippingAmount}
        max={refundableShipping}
        disabled={disabled || refundableShipping < 1}
        onChange={onShippingChange}
      />
    </div>
  );
}
