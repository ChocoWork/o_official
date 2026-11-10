import type { ReturnReason } from '@/lib/orders/returns/return-types';
import type { ReturnSide } from '@/lib/orders/unit-pricing/unit-pricing-types';

/**
 * 受け取りの「割引の扱い」の初めの値（FREQ-642 設計 2-3）。サーバーの計画と管理画面が同じ規則を読むための、純関数だけの置き場
 * （画面からも読むので、サーバー専用の物を import しない）。
 *
 * @impl FREQ-642-REQ-01
 * @design DD-ADMIN-022
 */

/** お店の側の事情として扱う返品の理由。ほかの理由はお客様のご都合 */
const SHOP_SIDE_REASONS: readonly ReturnReason[] = ['defective', 'wrong_item'];

/** 受け取りで直さなかった時の「割引の扱い」。理由から決まる。交換の頼みを店が返金に変えた行は、理由に関わらずお店の側 */
export function defaultTreatment(reason: ReturnReason, exchangeChangedToRefund: boolean): ReturnSide {
  return exchangeChangedToRefund || SHOP_SIDE_REASONS.includes(reason) ? 'shop' : 'customer';
}
