import { NextResponse } from 'next/server';
import { z } from 'zod';
import { authorizeAdminPermission } from '@/lib/auth/admin-rbac';
import { createServiceRoleClient } from '@/lib/supabase/server';
import type { OrderStatus } from '@/lib/orders/order-payment-types';
import { buildOrderHistory } from '@/lib/orders/email/order-history';
import {
  getOrderEmailSendState,
  listOrderEmailHistory,
  listOrderStatusHistory,
  type OrderEmailStore,
} from '@/lib/orders/email/order-email-store';

type HistoryOrderRow = { id: string; status: OrderStatus; shipping_email: string | null; created_at: string };

/** 「この注文の履歴」（グループ D 設計書 5-1）。注文の状態の変化とメールを新しい順に返す。本文は返さない */
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
    const [statusRows, emailRows, sendState] = await Promise.all([
      listOrderStatusHistory(store, order.id),
      listOrderEmailHistory(store, order.id),
      getOrderEmailSendState(store),
    ]);

    return NextResponse.json(
      buildOrderHistory({
        order: { id: order.id, status: order.status, shippingEmail: order.shipping_email, createdAt: order.created_at },
        statusRows,
        emailRows,
        sendState,
      }),
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (error) {
    console.error('[admin.orders.history] Failed to load history', error instanceof Error ? error.name : 'UnknownError');
    return NextResponse.json({ error: 'Failed to load history' }, { status: 500 });
  }
}
