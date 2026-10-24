'use client';

// File: src/components/AdminInventorySection.tsx
// 在庫一覧表（G-2 / FREQ-525）。商品（色・サイズ）ごとの注文数・在庫・発注済み・発注必要数を1つの表で見る。
// 発注（FREQ-526）は同じ表の上で 入力 → 確認 → 確定 の3段で行う。確認までは通信せず、確定で初めて発注書を保存する。
// 権限は窓口と DB が守り、この部品は返事の状態で出し分ける。
import { Fragment, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/Button/Button';
import { adminLoadFailureMessage } from '@/lib/admin/admin-load-failure';
import { clientFetch } from '@/lib/client-fetch';
import { formatStockBreakdown, INVENTORY_LIST_TEXT, type AdminInventoryRow } from '@/lib/inventory/inventory-list-types';
import {
  isPurchaseOrderQuantity,
  PURCHASE_ORDER_CREATED_QUERY,
  PURCHASE_ORDER_LIMITS,
  PURCHASE_ORDER_TEXT,
  purchaseOrderCreateFailureMessage,
} from '@/lib/purchase-orders/purchase-order-types';

const HEADINGS = ['商品名', '色', 'サイズ', '注文数', '在庫', '発注済み', '発注必要数'] as const;
const QUANTITY_HEADING = '発注数量';
const HEADING_ID = 'admin-inventory-heading';
const CONFIRM_HEADING_ID = 'admin-inventory-confirm-heading';
const HEAD_CELL = 'sticky top-0 z-10 whitespace-nowrap border-b border-black/15 bg-white p-3 font-normal';
const NUMBER_CELL = 'p-3 text-right tabular-nums';
const FIELD_CLASS =
  'w-full border border-black/20 bg-white px-3 py-2 lk-text-2xs text-black focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-black/40';
const SCROLL_REGION_CLASS = 'max-h-[70vh] max-w-full overflow-auto border border-black/15 focus-visible:outline-2';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type State =
  | { phase: 'loading' }
  | { phase: 'error'; message: string }
  | { phase: 'ready'; rows: AdminInventoryRow[] };

/** view: 一覧を見ているだけ / input: 発注数量を入れている / confirm: 発注書の確認（発注先とメモ） */
type OrderStage = 'view' | 'input' | 'confirm';

type OrderLine = { row: AdminInventoryRow; quantity: number };

function isRow(value: unknown): value is AdminInventoryRow {
  if (value === null || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  const numbers = ['variantId', 'itemId', 'free', 'paidAllocated', 'paymentHeld', 'onHand', 'orderQuantity', 'onOrder', 'required'];
  return numbers.every((key) => typeof row[key] === 'number')
    && typeof row.itemName === 'string' && typeof row.isActive === 'boolean'
    && (row.colorName === null || typeof row.colorName === 'string')
    && (row.sizeLabel === null || typeof row.sizeLabel === 'string');
}

function readRows(body: unknown): AdminInventoryRow[] | null {
  if (body === null || typeof body !== 'object') return null;
  const { rows } = body as { rows?: unknown };
  return Array.isArray(rows) && rows.every(isRow) ? rows : null;
}

/** 発注確定の成功の応答（窓口の 201 の本文）から発注書の id を取る。形が崩れていれば成功として扱わない */
function readCreatedId(body: unknown): string | null {
  if (body === null || typeof body !== 'object') return null;
  const { id, number } = body as { id?: unknown; number?: unknown };
  return typeof id === 'string' && UUID_PATTERN.test(id) && typeof number === 'string' && number !== '' ? id : null;
}

/** 色・サイズが無い variant は、有る部分だけを並べる */
function variantLabel(row: AdminInventoryRow): string {
  return [row.itemName, row.colorName, row.sizeLabel].filter((part): part is string => typeof part === 'string' && part !== '').join(' ');
}

export default function AdminInventorySection(): React.JSX.Element {
  const router = useRouter();
  const [state, setState] = useState<State>({ phase: 'loading' });
  const [openIds, setOpenIds] = useState<ReadonlySet<number>>(new Set());
  const [stage, setStage] = useState<OrderStage>('view');
  const [quantities, setQuantities] = useState<Readonly<Record<number, string>>>({});
  const [supplierName, setSupplierName] = useState('');
  const [memo, setMemo] = useState('');
  const [sending, setSending] = useState(false);
  const [orderError, setOrderError] = useState<string | null>(null);
  const sendingRef = useRef(false);
  // 同じ確認の再押下・通信の再送が使う本文と requestKey。内容が変わるか、確定した応答を受けたら捨てる
  const retry = useRef<{ signature: string; body: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    const failed: State = { phase: 'error', message: INVENTORY_LIST_TEXT.screenFailed };
    void (async () => {
      try {
        const response = await clientFetch('/api/admin/inventory', { cache: 'no-store' });
        const body: unknown = await response.json().catch(() => null);
        if (cancelled) return;
        if (!response.ok) {
          setState({
            phase: 'error',
            message: adminLoadFailureMessage(response.status, body, INVENTORY_LIST_TEXT.forbidden, INVENTORY_LIST_TEXT.screenFailed),
          });
          return;
        }
        const rows = readRows(body);
        setState(rows === null ? failed : { phase: 'ready', rows });
      } catch {
        if (!cancelled) setState(failed);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const toggle = (variantId: number): void => {
    setOpenIds((current) => {
      const next = new Set(current);
      if (!next.delete(variantId)) next.add(variantId);
      return next;
    });
  };

  const rows = state.phase === 'ready' ? state.rows : [];
  // 画面の並びのまま、正の整数（1〜99999）を入れた行だけが発注書に入る
  const orderLines: OrderLine[] = rows.flatMap((row) => {
    const value = quantities[row.variantId] ?? '';
    return isPurchaseOrderQuantity(value) ? [{ row, quantity: Number(value) }] : [];
  });

  const startOrder = (): void => {
    setOrderError(null);
    setQuantities({});
    setStage('input');
  };

  const cancelOrder = (): void => {
    setStage('view');
    setQuantities({});
    setSupplierName('');
    setMemo('');
    setOrderError(null);
    retry.current = null;
  };

  const submitOrder = async (): Promise<void> => {
    if (sendingRef.current) return;
    const name = supplierName.trim();
    if (name === '') {
      setOrderError(PURCHASE_ORDER_TEXT.supplierRequired);
      return;
    }
    const note = memo.trim();
    const payload = {
      supplierName: name,
      ...(note === '' ? {} : { memo: note }),
      lines: orderLines.map((line) => ({ variantId: line.row.variantId, quantity: line.quantity })),
    };
    const signature = JSON.stringify(payload);
    let attempt = retry.current;
    if (attempt?.signature !== signature) {
      attempt = { signature, body: JSON.stringify({ ...payload, requestKey: crypto.randomUUID() }) };
      retry.current = attempt;
    }
    sendingRef.current = true;
    setSending(true);
    setOrderError(null);
    try {
      const response = await clientFetch('/api/admin/purchase-orders', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: attempt.body,
      });
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        // 確定した応答（4xx）の後は新しい要求として送る。5xx は届いたか分からないので同じ requestKey を残す
        if (response.status < 500) retry.current = null;
        setOrderError(purchaseOrderCreateFailureMessage(response.status, body));
        return;
      }
      const created = readCreatedId(body);
      if (created === null) {
        setOrderError(PURCHASE_ORDER_TEXT.failed);
        return;
      }
      retry.current = null;
      cancelOrder();
      // 作成の通知はこの部品の状態に置くと移動で消える。目印を付けて渡し、発注書の頁（Task 5）が通知を出す
      router.push(`/admin/purchase-orders/${created}?${PURCHASE_ORDER_CREATED_QUERY}`);
    } catch {
      setOrderError(PURCHASE_ORDER_TEXT.failed);
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  };

  const headings = stage === 'input' ? [...HEADINGS, QUANTITY_HEADING] : [...HEADINGS];
  const quantityLimits = PURCHASE_ORDER_LIMITS.provisionalQuantity;

  return (
    <div className="w-full min-w-0 max-w-full space-y-6">
      <Button href="/admin" variant="secondary">管理画面に戻る</Button>
      <h1 id={HEADING_ID} className="lk-text-xl">在庫一覧表</h1>
      {state.phase === 'loading' ? <p role="status">読み込み中...</p> : null}
      {state.phase === 'error' ? <p role="alert">{state.message}</p> : null}
      {state.phase === 'ready' && state.rows.length === 0 ? <p>{INVENTORY_LIST_TEXT.empty}</p> : null}
      {state.phase === 'ready' && state.rows.length > 0 && stage === 'view' ? (
        <div>
          <Button size="sm" onClick={startOrder}>発注</Button>
        </div>
      ) : null}
      {state.phase === 'ready' && stage === 'input' ? (
        <div className="flex flex-wrap gap-3">
          <Button size="sm" disabled={orderLines.length === 0} onClick={() => { setOrderError(null); setStage('confirm'); }}>
            発注書確認
          </Button>
          <Button size="sm" variant="secondary" onClick={cancelOrder}>キャンセル</Button>
        </div>
      ) : null}
      {state.phase === 'ready' && state.rows.length > 0 && stage !== 'confirm' ? (
        <div
          role="region"
          aria-labelledby={HEADING_ID}
          tabIndex={0}
          className={SCROLL_REGION_CLASS}
        >
          <table className="w-full min-w-[44rem] border-collapse text-left">
            <thead>
              <tr>
                {headings.map((heading, index) => (
                  <th key={heading} scope="col" className={`${HEAD_CELL} ${index >= 3 ? 'text-right' : ''}`}>{heading}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {state.rows.map((row) => {
                const open = openIds.has(row.variantId);
                const panelId = `inventory-breakdown-${row.variantId}`;
                const nameId = `inventory-name-${row.variantId}`;
                return (
                  <Fragment key={row.variantId}>
                    <tr data-testid="inventory-row" className="border-b border-black/10 align-top">
                      <td id={nameId} className="break-words p-3">{row.itemName}</td>
                      <td className="break-words p-3">{row.colorName ?? '—'}</td>
                      <td className="break-words p-3">{row.sizeLabel ?? '—'}</td>
                      <td className={NUMBER_CELL}>{row.orderQuantity}</td>
                      <td className={NUMBER_CELL}>
                        <span>{row.onHand}</span>
                        <Button
                          variant="link"
                          size="sm"
                          className="ml-3 whitespace-nowrap"
                          aria-expanded={open}
                          aria-controls={open ? panelId : undefined}
                          aria-describedby={nameId}
                          onClick={() => toggle(row.variantId)}
                        >
                          在庫の内訳
                        </Button>
                      </td>
                      <td className={NUMBER_CELL}>{row.onOrder}</td>
                      <td className={NUMBER_CELL}>{row.required}</td>
                      {stage === 'input' ? (
                        <td className="p-3 text-right">
                          <input
                            type="number"
                            inputMode="numeric"
                            min={quantityLimits.min}
                            max={quantityLimits.max}
                            step={1}
                            aria-label={`${variantLabel(row)} の${QUANTITY_HEADING}`}
                            value={quantities[row.variantId] ?? ''}
                            onChange={(event) => {
                              const { value } = event.target;
                              setQuantities((current) => ({ ...current, [row.variantId]: value }));
                            }}
                            className={`${FIELD_CLASS} w-28 text-right tabular-nums`}
                          />
                        </td>
                      ) : null}
                    </tr>
                    {open ? (
                      <tr id={panelId} className="border-b border-black/10 bg-black/5">
                        <td colSpan={headings.length} className="p-3 lk-text-sm">{formatStockBreakdown(row)}</td>
                      </tr>
                    ) : null}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}
      {state.phase === 'ready' && stage === 'confirm' ? (
        <section className="space-y-4">
          <h2 id={CONFIRM_HEADING_ID} className="lk-text-lg">発注書の確認</h2>
          <div role="region" aria-labelledby={CONFIRM_HEADING_ID} tabIndex={0} className={SCROLL_REGION_CLASS}>
            <table className="w-full min-w-[28rem] border-collapse text-left">
              <thead>
                <tr>
                  {['商品名', '色', 'サイズ', QUANTITY_HEADING].map((heading, index) => (
                    <th key={heading} scope="col" className={`${HEAD_CELL} ${index === 3 ? 'text-right' : ''}`}>{heading}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {orderLines.map(({ row, quantity }) => (
                  <tr key={row.variantId} className="border-b border-black/10 align-top">
                    <td className="break-words p-3">{row.itemName}</td>
                    <td className="break-words p-3">{row.colorName ?? '—'}</td>
                    <td className="break-words p-3">{row.sizeLabel ?? '—'}</td>
                    <td className={NUMBER_CELL}>{quantity}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="space-y-1">
            <label htmlFor="purchase-order-supplier" className="block lk-text-2xs">発注先</label>
            <input
              id="purchase-order-supplier"
              type="text"
              required
              maxLength={PURCHASE_ORDER_LIMITS.supplierName.max}
              value={supplierName}
              onChange={(event) => setSupplierName(event.target.value)}
              className={FIELD_CLASS}
            />
          </div>
          <div className="space-y-1">
            <label htmlFor="purchase-order-memo" className="block lk-text-2xs">メモ</label>
            <textarea
              id="purchase-order-memo"
              rows={3}
              maxLength={PURCHASE_ORDER_LIMITS.memo.max}
              value={memo}
              onChange={(event) => setMemo(event.target.value)}
              className={FIELD_CLASS}
            />
          </div>
          {orderError !== null ? <p role="alert" className="lk-text-2xs text-red-600">{orderError}</p> : null}
          <div className="flex flex-wrap gap-3">
            <Button disabled={sending} onClick={() => { void submitOrder(); }}>発注確定</Button>
            <Button variant="secondary" disabled={sending} onClick={() => { setOrderError(null); setStage('input'); }}>戻る</Button>
          </div>
        </section>
      ) : null}
    </div>
  );
}
