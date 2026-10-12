'use client';

import { useState, type FormEvent } from 'react';
import { RefundFlowContent } from '@/components/RefundFlowContent';
import { Button } from '@/components/ui/Button/Button';
import { Checkbox } from '@/components/ui/Checkbox/Checkbox';
import { Dialog } from '@/components/ui/Dialog/Dialog';
import { SingleSelect } from '@/components/ui/SingleSelect/SingleSelect';
import { TagLabel } from '@/components/ui/TagLabel/TagLabel';
import { TextAreaField } from '@/components/ui/TextAreaField/TextAreaField';
import { blockEnterSubmit, useRefundSubmission } from '@/hooks/useRefundSubmission';
import { clampQuantity, lineLabel } from '@/lib/orders/fulfillment/fulfillment-client';
import { ADMIN_NOTE_MAX_LENGTH } from '@/lib/orders/order-payment-types';
import { estimateRefund, selectsAllUnshipped, type RefundSelection } from '@/lib/orders/refund/refund-allocation';
import {
  REFUND_FAILURE_MESSAGES,
  STRIPE_REFUND_REASON_LABELS,
  formatYen,
  refundTimingNote,
} from '@/lib/orders/refund/refund-messages';
import {
  STRIPE_REFUND_REASONS,
  type CreateRefundRequest,
  type RefundAcceptedResponse,
  type RefundMaterialLine,
  type RefundMaterials,
  type StripeRefundReason,
} from '@/lib/orders/refund/refund-types';

type OrderRefundDialogProps = {
  /** 開いている注文。null なら閉じている */
  orderId: string | null;
  onClose: () => void;
  /** 返金を受け付けた（同じ二重防止の番号の送り直しで前の結果が返った時も）。親が知らせを出して一覧を読み直す */
  onRefunded: (result: RefundAcceptedResponse) => void;
  /** 答えが分からないまま閉じた。返金が頼まれたかもしれないので、親が一覧を読み直す */
  onUncertain?: () => void;
};

type OrderRefundDialogBodyProps = Omit<OrderRefundDialogProps, 'orderId'> & { orderId: string };

const REASON_OPTIONS = STRIPE_REFUND_REASONS.map((reason) => ({ value: reason, label: STRIPE_REFUND_REASON_LABELS[reason] }));

function isStripeReason(value: string): value is StripeRefundReason {
  return (STRIPE_REFUND_REASONS as readonly string[]).includes(value);
}

// 割引の行の符号は U+2212（ハイフンではなくマイナス記号）
const MINUS = '\u2212';
const RESTOCK_HINT = '発送前の在庫の品を、すぐ出せる数に戻します。';
const BACKORDER_NOTICE =
  '受注生産の品は在庫を確保していないため、在庫には戻りません。仕上がった品を売る時は、商品の在庫の画面で「入荷」してください。';
const SHIPPED_NOTICE = '品物が戻る時は、先に返品を作ってください。';
const FULL_REFUND_NOTICE = 'まだ発送していない注文の商品を全部返すので、送料と返金額も全部返します。';
const FRAUD_NOTICE = '「不正の疑い」を選ぶと、Stripe がこのカードとメールアドレスを拒否の一覧に入れます。';

/** 数の入力の持ち主。同じ商品が発送前と発送済みの両方に出るので、商品の番号と区分で分ける */
function quantityKey(orderItemId: string, beforeShipment: boolean): string {
  return `${orderItemId}-${beforeShipment ? 'before' : 'after'}`;
}

/** 全部を返す時に入れる送料。DB の REFUND_MUST_BE_FULL は、送料が min(返せる送料, 返せる額) であることを求める（送料 ≤ 額） */
function fullRefundShipping(order: RefundMaterials['order']): number {
  return Math.min(order.refundableShipping, order.refundableAmount);
}

type NumberInputProps = {
  id: string;
  label: string;
  value: number;
  max: number;
  disabled: boolean;
  /** 入力欄の下の補足（返せる送料・返せる額） */
  hint?: string;
  onChange: (next: number) => void;
};

function NumberInput({ id, label, value, max, disabled, hint, onChange }: NumberInputProps) {
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
        aria-describedby={hint ? `${id}-hint` : undefined}
        onChange={(event) => onChange(clampQuantity(event.target.value, max))}
        className="mt-1 h-9 w-full border border-[#d4d4d4] bg-white px-2 font-acumin lk-text-3xs text-black disabled:bg-[#f3f3f3]"
      />
      {hint ? (
        <p id={`${id}-hint`} className="mt-1 font-acumin lk-text-3xs text-[#474747]">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

type RefundLineRowProps = {
  line: RefundMaterialLine;
  beforeShipment: boolean;
  /** この区分で返せる数の上限（発送前は未発送の数、発送済みは発送後に返せる数） */
  max: number;
  value: number;
  disabled: boolean;
  onChange: (next: number) => void;
};

function RefundLineRow({ line, beforeShipment, max, value, disabled, onChange }: RefundLineRowProps) {
  const label = lineLabel(line);
  return (
    <li>
      <div role="group" aria-label={label} className="space-y-2 border border-[#d4d4d4] p-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-acumin lk-text-sm text-black">{label}</span>
          <TagLabel variant="outline" size="2xs">
            {line.fulfillmentType === 'stock' ? '在庫' : '受注生産'}
          </TagLabel>
          {/* 返品の交換で足された品（元の品の支払額が入る行）。同じ商品名の行が2つ並ぶので、印で見分ける */}
          {line.exchangePaidAmount != null ? (
            <TagLabel variant="outline" size="2xs">交換の品</TagLabel>
          ) : null}
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <p className="font-acumin lk-text-3xs text-[#474747]">返金できる数</p>
            <p className="font-acumin lk-text-sm text-black">{max}</p>
          </div>
          <NumberInput
            id={`refund-quantity-${quantityKey(line.orderItemId, beforeShipment)}`}
            label="返金する数"
            value={value}
            max={max}
            disabled={disabled}
            onChange={onChange}
          />
        </div>
      </div>
    </li>
  );
}

/**
 * 返金の画面（グループ E-2 設計書 5-1。Shopify の返金の画面に合わせる）。
 * 開く時に返金の材料を読み、発送前・発送済みの商品ごとに返す数を入れ、送料と返金額を決めて返金する。
 * 開くたびに中身を作り直す（key に注文を使う）ので、二重防止の番号も入力も開くたびに新しくなる。
 */
export default function OrderRefundDialog({ orderId, onClose, onRefunded, onUncertain }: OrderRefundDialogProps) {
  return orderId ? (
    <OrderRefundDialogBody key={orderId} orderId={orderId} onClose={onClose} onRefunded={onRefunded} onUncertain={onUncertain} />
  ) : null;
}

function OrderRefundDialogBody({ orderId, onClose, onRefunded, onUncertain }: OrderRefundDialogBodyProps) {
  const flow = useRefundSubmission({
    orderId,
    submitUrl: `/api/admin/orders/${orderId}/refund`,
    fallbackMessage: REFUND_FAILURE_MESSAGES.create,
    onAccepted: onRefunded,
    onClose,
    onUncertain,
  });
  const { materials, awaiting } = flow;
  const [quantities, setQuantities] = useState<Record<string, number>>({});
  const [shippingEntered, setShippingEntered] = useState(0);
  // 返金額を手で直した時だけ入る。商品の数・送料・「すべて選ぶ」を変えたら空に戻し、内訳の合計に追い付かせる
  const [amountEntered, setAmountEntered] = useState<number | null>(null);
  const [restock, setRestock] = useState(true);
  const [stripeReason, setStripeReason] = useState<StripeRefundReason>('requested_by_customer');
  const [note, setNote] = useState('');
  const [notifyCustomer, setNotifyCustomer] = useState(true);

  const order = materials?.order ?? null;
  const beforeLines = materials?.lines.filter((line) => line.unshipped >= 1) ?? [];
  const afterLines = materials?.lines.filter((line) => line.shippedRefundable >= 1) ?? [];
  const quantityOf = (line: RefundMaterialLine, beforeShipment: boolean) =>
    quantities[quantityKey(line.orderItemId, beforeShipment)] ?? 0;
  const selections: RefundSelection[] = [
    ...beforeLines.map((line) => ({ orderItemId: line.orderItemId, beforeShipment: true, quantity: quantityOf(line, true) })),
    ...afterLines.map((line) => ({ orderItemId: line.orderItemId, beforeShipment: false, quantity: quantityOf(line, false) })),
  ].filter((selection) => selection.quantity >= 1);
  const selectedBefore = beforeLines.filter((line) => quantityOf(line, true) >= 1);
  // 「在庫に戻す」は、発送前に選んだ在庫の品に、在庫に戻せる数（restockable）が1以上の行がある時だけ。戻せる数が0
  // （在庫を確保できなかった注文など）なら DB は何も戻さないので出さない。受注生産の品は在庫を確保していないので、戻らない注意を出す
  const showRestock = selectedBefore.some((line) => line.fulfillmentType === 'stock' && line.restockable >= 1);
  const showBackorderNotice = selectedBefore.some((line) => line.fulfillmentType === 'backorder');
  // 1つも発送していない注文の商品を全部選んだ時は、送る物が無いのにキャンセルにならない注文を残さないため、送料と額を全部に固定する
  // （送料は min(返せる送料, 返せる額)、額は返せる額の全部。DB の REFUND_MUST_BE_FULL と同じ）
  const fixedFull = materials ? selectsAllUnshipped(materials, selections) : false;
  const stopped = flow.busy || flow.uncertain;
  const shippingAmount = order && fixedFull ? fullRefundShipping(order) : shippingEntered;
  const estimate = materials ? estimateRefund(materials.lines, selections, shippingAmount) : null;
  const amount =
    order && estimate ? (fixedFull ? order.refundableAmount : Math.min(order.refundableAmount, amountEntered ?? estimate.total)) : 0;
  const breakdownRows: Array<[string, string]> = estimate
    ? [
        ['商品', formatYen(estimate.itemsAmount)],
        ['割引', estimate.discountAmount > 0 ? `${MINUS}${formatYen(estimate.discountAmount)}` : formatYen(0)],
        ['送料', formatYen(estimate.shippingAmount)],
        ['返金額', formatYen(estimate.total)],
      ]
    : [];

  const changeQuantity = (line: RefundMaterialLine, beforeShipment: boolean, next: number) => {
    setQuantities((previous) => ({ ...previous, [quantityKey(line.orderItemId, beforeShipment)]: next }));
    setAmountEntered(null);
  };

  const changeShipping = (next: number) => {
    setShippingEntered(next);
    setAmountEntered(null);
  };

  const selectAll = () => {
    if (!materials) return;
    const next: Record<string, number> = {};
    for (const line of materials.lines) {
      if (line.unshipped >= 1) next[quantityKey(line.orderItemId, true)] = line.unshipped;
      if (line.shippedRefundable >= 1) next[quantityKey(line.orderItemId, false)] = line.shippedRefundable;
    }
    setQuantities(next);
    setShippingEntered(fullRefundShipping(materials.order));
    setAmountEntered(null);
  };

  // DB は「送料 ≤ 額」を入力の誤りにする。画面に新しい文は足さず、直るまで押せなくする
  const canSubmit = Boolean(materials) && !awaiting && !stopped && amount >= 1 && amount >= shippingAmount;

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canSubmit) return;
    flow.submit(
      (requestKey): CreateRefundRequest => ({
        requestKey,
        lines: selections.map(({ orderItemId, beforeShipment, quantity }) => ({ orderItemId, quantity, beforeShipment })),
        restock,
        shippingAmount,
        amount,
        note: note.trim() || null,
        stripeReason,
        notifyCustomer,
      }),
    );
  };

  return (
    <Dialog open onClose={flow.close} title="返金" fullScreenOnMobile>
      <form className="space-y-3" onSubmit={handleSubmit} onKeyDown={blockEnterSubmit}>
        <RefundFlowContent
          flow={flow}
          backLabel="キャンセル"
          submitLabel={`${formatYen(amount)} を返金する`}
          canSubmit={canSubmit}
        >
          {order && estimate && !awaiting ? (
            // 幅が 768px 以上の Dialog は高さを制限しないので、入力の部分だけを縦に動かし、誤りの文とボタンは動かさない
            <div className="space-y-3 md:max-h-[60vh] md:overflow-y-auto md:pr-1">
              <p className="font-acumin lk-text-3xs text-[#474747]">{refundTimingNote(order.paymentMethod)}</p>
              <div className="flex justify-end">
                <Button variant="secondary" size="sm" className="font-acumin" disabled={stopped} onClick={selectAll}>
                  すべて選ぶ
                </Button>
              </div>

              {beforeLines.length > 0 ? (
                <section aria-labelledby="refund-before-heading" className="space-y-2">
                  <h4 id="refund-before-heading" className="font-acumin lk-text-sm text-black">
                    発送前の商品
                  </h4>
                  <ul className="space-y-3">
                    {beforeLines.map((line) => (
                      <RefundLineRow
                        key={line.orderItemId}
                        line={line}
                        beforeShipment
                        max={line.unshipped}
                        value={quantityOf(line, true)}
                        disabled={stopped}
                        onChange={(next) => changeQuantity(line, true, next)}
                      />
                    ))}
                  </ul>
                </section>
              ) : null}

              {afterLines.length > 0 ? (
                <section aria-labelledby="refund-after-heading" className="space-y-2">
                  <h4 id="refund-after-heading" className="font-acumin lk-text-sm text-black">
                    発送済みの商品
                  </h4>
                  <p className="font-acumin lk-text-3xs text-[#474747]">{SHIPPED_NOTICE}</p>
                  <ul className="space-y-3">
                    {afterLines.map((line) => (
                      <RefundLineRow
                        key={line.orderItemId}
                        line={line}
                        beforeShipment={false}
                        max={line.shippedRefundable}
                        value={quantityOf(line, false)}
                        disabled={stopped}
                        onChange={(next) => changeQuantity(line, false, next)}
                      />
                    ))}
                  </ul>
                </section>
              ) : null}

              {showRestock ? (
                <div className="space-y-1">
                  <Checkbox
                    label="在庫に戻す"
                    checked={restock}
                    disabled={stopped}
                    aria-describedby="refund-restock-hint"
                    onChange={(event) => setRestock(event.target.checked)}
                  />
                  <p id="refund-restock-hint" className="font-acumin lk-text-3xs text-[#474747]">
                    {RESTOCK_HINT}
                  </p>
                </div>
              ) : null}
              {showBackorderNotice ? <p className="font-acumin lk-text-3xs text-[#474747]">{BACKORDER_NOTICE}</p> : null}

              <NumberInput
                id="refund-shipping"
                label="送料"
                value={shippingAmount}
                max={order.refundableShipping}
                disabled={stopped || fixedFull || order.refundableShipping < 1}
                hint={`返せる送料: ${formatYen(order.refundableShipping)}`}
                onChange={changeShipping}
              />
              {fixedFull ? <p className="font-acumin lk-text-3xs text-[#474747]">{FULL_REFUND_NOTICE}</p> : null}

              <div role="group" aria-label="返金の内訳" className="border-t border-[#d4d4d4] pt-3">
                <dl className="space-y-1">
                  {breakdownRows.map(([term, value]) => (
                    <div key={term} className="flex justify-between font-acumin lk-text-sm text-black">
                      <dt>{term}</dt>
                      <dd>{value}</dd>
                    </div>
                  ))}
                </dl>
              </div>
              <NumberInput
                id="refund-amount"
                label="返金額"
                value={amount}
                max={order.refundableAmount}
                disabled={stopped || fixedFull}
                hint={`返せる額: ${formatYen(order.refundableAmount)}`}
                onChange={setAmountEntered}
              />

              <SingleSelect
                label="Stripe に伝える理由"
                options={REASON_OPTIONS}
                value={stripeReason}
                disabled={stopped}
                onChange={(event) => {
                  const value = event.target.value;
                  if (isStripeReason(value)) setStripeReason(value);
                }}
              />
              {stripeReason === 'fraudulent' ? <p className="font-acumin lk-text-3xs text-[#474747]">{FRAUD_NOTICE}</p> : null}
              <TextAreaField
                label="メモ（お客様には見えません）"
                value={note}
                rows={3}
                maxLength={ADMIN_NOTE_MAX_LENGTH}
                disabled={stopped}
                onChange={(event) => setNote(event.target.value)}
              />
              <Checkbox
                label="お客様に返金のメールを送る"
                checked={notifyCustomer}
                disabled={stopped}
                onChange={(event) => setNotifyCustomer(event.target.checked)}
              />
              <p className="font-acumin lk-text-3xs text-[#474747]">返金は取り消せません。</p>
            </div>
          ) : null}

        </RefundFlowContent>
      </form>
    </Dialog>
  );
}
