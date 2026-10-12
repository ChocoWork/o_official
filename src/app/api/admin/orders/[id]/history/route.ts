import { NextResponse } from 'next/server';
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import { authorizeAdminPermission } from '@/lib/auth/admin-rbac';
import { createServiceRoleClient } from '@/lib/supabase/server';
import type { OrderStatus } from '@/lib/orders/order-payment-types';
import {
  buildOrderHistory,
  type OrderHistoryLine,
  type OrderHistoryReturnReceiptLine,
  type OrderHistoryReturnRecord,
} from '@/lib/orders/email/order-history';
import {
  getOrderEmailSendState,
  listOrderEmailHistory,
  listOrderStatusHistory,
  OrderEmailStoreError,
  type OrderEmailStore,
} from '@/lib/orders/email/order-email-store';
import {
  FulfillmentStoreError,
  listOrderCompletions,
  listOrderFulfillments,
  listOrderLineFulfillment,
} from '@/lib/orders/fulfillment/fulfillment-store';
import { listOrderRefunds, RefundStoreError } from '@/lib/orders/refund/refund-store';
import { listOrderReturns } from '@/lib/orders/returns/return-store';
import type { OrderReturnDetail } from '@/lib/orders/returns/return-types';

type HistoryOrderRow = { id: string; status: OrderStatus; shipping_email: string | null; created_at: string };
type HistoryItemRow = {
  id: string;
  item_name: string;
  color: string | null;
  size: string | null;
  quantity: number;
  /** 交換の品の行（返品の交換で足した行）は exchange。読めなかった行（古い見本）は order と同じに扱う */
  line_kind?: 'order' | 'exchange';
  created_at: string;
};
type ReceiptLineRow = { receipt_id: string; disposition: string; quantity: number };
type ReturnRecordRow = {
  id: string;
  cancelled_by: string | null;
  fee_received_by: string | null;
  exchange_released_by: string | null;
  fee_waived: boolean;
  fee_settled_amount: number;
};

/**
 * 注文の商品ごとの名前と、発送した数・仕上がった数。名前はメールの明細と同じ「商品名（色 / サイズ）」。
 * 発送と仕上がりの行に商品の名前を出し、仕上がりを取り消せるかを決めるのに使う。
 * 交換の品の行（返品の交換で足した行）は、足した数と時刻も持つ（履歴の「交換の品を足した」の行になる。グループ E-3）
 */
async function loadHistoryLines(client: SupabaseClient, orderId: string): Promise<OrderHistoryLine[]> {
  const [itemsResult, countsByOrder] = await Promise.all([
    client.from('order_items').select('id, item_name, color, size, quantity, line_kind, created_at').eq('order_id', orderId),
    listOrderLineFulfillment(client, [orderId]),
  ]);
  if (itemsResult.error) {
    throw new FulfillmentStoreError('load_order_items', itemsResult.error);
  }
  const counts = new Map((countsByOrder.get(orderId) ?? []).map((row) => [row.orderItemId, row] as const));
  return ((itemsResult.data ?? []) as HistoryItemRow[]).flatMap((item): OrderHistoryLine[] => {
    const row = counts.get(item.id);
    if (!row) {
      return [];
    }
    const variant = [item.color, item.size].filter(Boolean).join(' / ');
    return [{
      orderItemId: item.id,
      name: variant ? `${item.item_name}（${variant}）` : item.item_name,
      shipped: row.shipped,
      completed: row.completed,
      ...(item.line_kind === 'exchange' ? { exchange: { quantity: item.quantity, createdAt: item.created_at } } : {}),
    }];
  });
}

/**
 * 受け取りごとの品の状態の数（order_return_receipt_lines）。履歴の「返品の受け取り」の細目と「届かない」「返金しない」の数に使う。
 * 返品の一覧（list_order_returns）は受け取りの数を持たない（共通の約束 C-2 の形は変えない）ので、service_role で直に読む
 * （service_role は SELECT だけを持つ）。受け取りが無い注文は読まない
 */
async function loadReturnReceiptLines(
  client: SupabaseClient,
  returns: readonly OrderReturnDetail[],
): Promise<OrderHistoryReturnReceiptLine[]> {
  const receiptIds = returns.flatMap((detail) => detail.receipts.map((receipt) => receipt.id));
  if (receiptIds.length === 0) {
    return [];
  }
  const { data, error } = await client
    .from('order_return_receipt_lines')
    .select('receipt_id, disposition, quantity')
    .in('receipt_id', receiptIds);
  if (error) {
    throw new FulfillmentStoreError('load_return_receipt_lines', error);
  }
  return ((data ?? []) as ReceiptLineRow[]).map((row) => ({
    receiptId: row.receipt_id,
    disposition: row.disposition,
    quantity: Number(row.quantity),
  }));
}

/**
 * 返品の記録（order_returns）にだけある欄として、取消・手数料の受け取り・支払いを待たずに送るをした人のメール（設計書 8-1「日時とした人つき」）と、
 * 手数料をいただかないことにした印（fee_waived。本計画 P27）と決着済み額（fee_settled_amount。Task 3 の I-2）を読む。返品の一覧（list_order_returns。共通の約束 C-2）はどれも持たないので、
 * 受け取りの細目と同じく order_returns を service_role で直に読み（service_role は SELECT だけを持つ）、人の番号からメールを引く。
 * 取消・手数料の受け取り・支払いを待たずに送るの、どの時刻も無い返品は読まない
 */
async function loadReturnRecords(
  client: SupabaseClient,
  returns: readonly OrderReturnDetail[],
): Promise<OrderHistoryReturnRecord[]> {
  const returnIds = returns
    .filter((detail) => detail.cancelledAt !== null || detail.fees.feeReceivedAt !== null || detail.fees.exchangeReleasedAt !== null)
    .map((detail) => detail.id);
  if (returnIds.length === 0) {
    return [];
  }
  const { data, error } = await client
    .from('order_returns')
    .select('id, cancelled_by, fee_received_by, exchange_released_by, fee_waived, fee_settled_amount')
    .in('id', returnIds);
  if (error) {
    throw new FulfillmentStoreError('load_return_records', error);
  }
  const rows = (data ?? []) as ReturnRecordRow[];
  const actorIds = [
    ...new Set(
      rows
        .flatMap((row) => [row.cancelled_by, row.fee_received_by, row.exchange_released_by])
        .filter((actorId): actorId is string => actorId !== null),
    ),
  ];
  // 同じ人は1回だけ引く
  const emailById = new Map(
    await Promise.all(actorIds.map(async (actorId) => [actorId, await actorEmailOf(client, actorId)] as const)),
  );
  const emailOf = (actorId: string | null) => (actorId === null ? null : (emailById.get(actorId) ?? null));
  return rows.map((row) => ({
    returnId: row.id,
    cancelledByEmail: emailOf(row.cancelled_by),
    feeReceivedByEmail: emailOf(row.fee_received_by),
    exchangeReleasedByEmail: emailOf(row.exchange_released_by),
    feeWaived: row.fee_waived === true,
    feeSettledAmount: Number(row.fee_settled_amount),
  }));
}

/**
 * 人の番号からメール（Auth の管理の窓口。管理画面の利用者の窓口 admin/users/route.ts と同じ引き方）。メソッドを auth.admin から外して呼ばない
 * （src/features/auth/services/auth-admin-user.ts の注意）。消えた利用者（404）は null（DB の関数が auth.users を外部結合した時と同じ）。
 * ほかの失敗は投げる（履歴を 500 にする。ログには名前と記号だけが出る）
 */
async function actorEmailOf(client: SupabaseClient, actorId: string): Promise<string | null> {
  const { data, error } = await client.auth.admin.getUserById(actorId);
  if (error) {
    if (error.status === 404) {
      return null;
    }
    throw new FulfillmentStoreError('load_return_actor_email', { code: error.code ?? `status_${error.status ?? 'unknown'}` });
  }
  return data.user?.email ?? null;
}

/** 「この注文の履歴」（グループ D 設計書 5-1、グループ E-1・E-2・E-3 設計書 9-2・8-1）。状態の変化・メール・発送・仕上がり・返金・返品とその取消を新しい順に返す。本文は返さない */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const authz = await authorizeAdminPermission('admin.orders.read', request);
  if (!authz.ok) {
    return authz.response;
  }

  const { id } = await params;
  const parsedId = z.string().uuid().safeParse(id);
  if (!parsedId.success) {
    return NextResponse.json({ error: 'Invalid order id' }, { status: 400 });
  }

  try {
    const supabase = await createServiceRoleClient();
    const { data: order, error } = await supabase
      .from('orders')
      .select('id, status, shipping_email, created_at')
      .eq('id', parsedId.data)
      .maybeSingle<HistoryOrderRow>();
    if (error) {
      throw error;
    }
    if (!order) {
      return NextResponse.json({ error: 'Order not found' }, { status: 404 });
    }

    const store = supabase as unknown as OrderEmailStore;
    const [statusRows, emailRows, sendState, fulfillments, completions, refunds, returns, lines] = await Promise.all([
      listOrderStatusHistory(store, order.id),
      listOrderEmailHistory(store, order.id),
      getOrderEmailSendState(store),
      listOrderFulfillments(supabase, order.id),
      listOrderCompletions(supabase, order.id),
      listOrderRefunds(supabase, order.id),
      listOrderReturns(supabase, order.id),
      loadHistoryLines(supabase, order.id),
    ]);
    // 受け取りの細目と、返品の記録（取消などをした人と手数料をいただかない印）は、返品の一覧で番号が分かってから読む
    const [returnReceiptLines, returnRecords] = await Promise.all([
      loadReturnReceiptLines(supabase, returns),
      loadReturnRecords(supabase, returns),
    ]);

    return NextResponse.json(
      buildOrderHistory({
        order: { id: order.id, status: order.status, shippingEmail: order.shipping_email, createdAt: order.created_at },
        statusRows,
        emailRows,
        sendState,
        fulfillments,
        completions,
        refunds,
        returns,
        returnReceiptLines,
        returnRecords,
        lines,
      }),
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (error) {
    console.error('[admin.orders.history] Failed to load history', error instanceof Error ? error.name : 'UnknownError',
      ...((error instanceof OrderEmailStoreError || error instanceof FulfillmentStoreError || error instanceof RefundStoreError)
        && error.code ? [error.code] : []));
    return NextResponse.json({ error: 'Failed to load history' }, { status: 500 });
  }
}
