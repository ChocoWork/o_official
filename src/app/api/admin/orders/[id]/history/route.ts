import { NextResponse } from 'next/server';
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import { authorizeAdminPermission } from '@/lib/auth/admin-rbac';
import { createServiceRoleClient } from '@/lib/supabase/server';
import type { OrderStatus } from '@/lib/orders/order-payment-types';
import { buildOrderHistory, type OrderHistoryLine } from '@/lib/orders/email/order-history';
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

type HistoryOrderRow = { id: string; status: OrderStatus; shipping_email: string | null; created_at: string };
type HistoryItemRow = { id: string; item_name: string; color: string | null; size: string | null };

/**
 * 注文の商品ごとの名前と、発送した数・仕上がった数。名前はメールの明細と同じ「商品名（色 / サイズ）」。
 * 発送と仕上がりの行に商品の名前を出し、仕上がりを取り消せるかを決めるのに使う。
 */
async function loadHistoryLines(client: SupabaseClient, orderId: string): Promise<OrderHistoryLine[]> {
  const [itemsResult, countsByOrder] = await Promise.all([
    client.from('order_items').select('id, item_name, color, size').eq('order_id', orderId),
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
    }];
  });
}

/** 「この注文の履歴」（グループ D 設計書 5-1、グループ E-1 設計書 9-2）。状態の変化・メール・発送・仕上がりとその取消を新しい順に返す。本文は返さない */
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
    const [statusRows, emailRows, sendState, fulfillments, completions, lines] = await Promise.all([
      listOrderStatusHistory(store, order.id),
      listOrderEmailHistory(store, order.id),
      getOrderEmailSendState(store),
      listOrderFulfillments(supabase, order.id),
      listOrderCompletions(supabase, order.id),
      loadHistoryLines(supabase, order.id),
    ]);

    return NextResponse.json(
      buildOrderHistory({
        order: { id: order.id, status: order.status, shippingEmail: order.shipping_email, createdAt: order.created_at },
        statusRows,
        emailRows,
        sendState,
        fulfillments,
        completions,
        lines,
      }),
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (error) {
    console.error('[admin.orders.history] Failed to load history', error instanceof Error ? error.name : 'UnknownError',
      ...((error instanceof OrderEmailStoreError || error instanceof FulfillmentStoreError) && error.code ? [error.code] : []));
    return NextResponse.json({ error: 'Failed to load history' }, { status: 500 });
  }
}
