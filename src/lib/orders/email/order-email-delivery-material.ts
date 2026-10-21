import type { SupabaseClient } from '@supabase/supabase-js';
import {
  loadOrderEmailMaterial,
  OrderEmailMaterialError,
  type OrderEmailMaterial,
} from '@/lib/orders/email/order-email-compose';
import type { ClaimedOrderEmail } from '@/lib/orders/email/order-email-store';
import { isDeliveryEmailKind } from '@/lib/orders/email/order-email-types';
import { DELIVERY_STATUSES, type DeliveryStatus } from '@/lib/orders/tracking/delivery-types';
import { isShippingCarrierId, type ShippingCarrierId } from '@/lib/orders/shipping-carriers';

export type OrderEmailDeliveryMaterial = {
  fulfillmentId: string;
  trackingVersion: number;
  currentTrackingVersion: number;
  cancelled: boolean;
  deliveryStatus: DeliveryStatus;
  deliveredAt: string | null;
  windowDays: number | null;
  carrier: ShippingCarrierId | null;
  trackingNumber: string | null;
};

type DeliveryRow = {
  tracking_version: number;
  cancelled_at: string | null;
  delivery_status: DeliveryStatus;
  delivered_at: string | null;
  shipping_carrier: string | null;
  tracking_number: string | null;
};
type ChangeRow = { to_carrier: string; to_tracking_number: string };

/**
 * 注文・発送・商品の読み方は既存と共通。現在値は本文の再利用より前に読み直す。
 * changeにorder_idは無いので、注文で絞った発送とchangeの所属・版を合わせる。
 * 旧版も材料を返し、配達中/配達済みだけworkerがsupersededにする。
 */
export async function loadDeliveryEmailMaterial(
  store: Pick<SupabaseClient, 'from' | 'rpc'>,
  claim: ClaimedOrderEmail,
): Promise<OrderEmailMaterial | null> {
  const version = claim.trackingVersion;
  if (!isDeliveryEmailKind(claim.kind) || !claim.fulfillmentId || typeof version !== 'number'
    || !Number.isInteger(version) || version < 1
    || (claim.kind === 'shipping_update' && !claim.trackingChangeId)) return null;

  const material = await loadOrderEmailMaterial(store, claim.orderId, claim.fulfillmentId);
  if (!material) return null;

  const { data: current, error } = await store.from('order_fulfillments')
    .select('tracking_version, cancelled_at, delivery_status, delivered_at, shipping_carrier, tracking_number')
    .eq('id', claim.fulfillmentId).eq('order_id', claim.orderId).maybeSingle<DeliveryRow>();
  if (error) throw new OrderEmailMaterialError('order_fulfillments', { cause: error });
  if (!current || !Number.isInteger(current.tracking_version) || current.tracking_version < 1
    || !DELIVERY_STATUSES.includes(current.delivery_status)) return null;

  let carrier = current.shipping_carrier;
  let trackingNumber = current.tracking_number;
  if (claim.kind === 'shipping_update') {
    const { data: change, error: changeError } = await store.from('order_fulfillment_tracking_changes')
      .select('to_carrier, to_tracking_number')
      .eq('id', claim.trackingChangeId).eq('fulfillment_id', claim.fulfillmentId).eq('tracking_version', version)
      .maybeSingle<ChangeRow>();
    if (changeError) throw new OrderEmailMaterialError('order_fulfillment_tracking_changes', { cause: changeError });
    if (!change) return null;
    carrier = change.to_carrier;
    trackingNumber = change.to_tracking_number;
  }

  let windowDays: number | null = null;
  if (claim.kind === 'delivered') {
    const { data: settings, error: settingsError } = await store.from('shop_return_settings')
      .select('window_days').eq('id', 1).maybeSingle<{ window_days: number | null }>();
    if (settingsError) throw new OrderEmailMaterialError('shop_return_settings', { cause: settingsError });
    if (!settings || (settings.window_days !== null
      && (!Number.isInteger(settings.window_days) || settings.window_days < 1 || settings.window_days > 365))) return null;
    windowDays = settings.window_days;
  }

  return {
    ...material,
    delivery: {
      fulfillmentId: claim.fulfillmentId, trackingVersion: version, currentTrackingVersion: current.tracking_version,
      cancelled: current.cancelled_at !== null, deliveryStatus: current.delivery_status, deliveredAt: current.delivered_at,
      windowDays, carrier: isShippingCarrierId(carrier) ? carrier : null, trackingNumber,
    },
  };
}
