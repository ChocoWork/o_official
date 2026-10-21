import type { ShippingCarrierId } from '@/lib/orders/shipping-carriers';
import type { PgClient } from './local-db';

/** 管理 RPC の実装と独立して記録の守りを試すため、発送の行だけを SQL で作る。商品行は呼び出し側が用意する。 */
export async function insertDeliveryFixture(
  client: PgClient,
  input: {
    orderId: string;
    shippedAt: string;
    carrier?: ShippingCarrierId;
    trackingNumber?: string;
    notifyCustomer?: boolean;
  },
): Promise<{ fulfillmentId: string }> {
  const result = await client.query(
    `insert into public.order_fulfillments
       (order_id, number, request_key, shipping_carrier, tracking_number, notify_customer,
        completes_order, shipped_at, delivery_status_at)
     select $1, coalesce(max(number), 0) + 1, gen_random_uuid(), $3, $4, $5, false, $2, $2
     from public.order_fulfillments where order_id = $1
     returning id`,
    [input.orderId, input.shippedAt, input.carrier ?? 'yamato', input.trackingNumber ?? 'DELIVERY-123', input.notifyCustomer ?? false],
  );
  return { fulfillmentId: result.rows[0].id as string };
}
