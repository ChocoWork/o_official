import type { SupabaseClient } from '@supabase/supabase-js';
import type { FulfillmentMaterials } from '@/lib/orders/fulfillment/fulfillment-types';
import {
  LEGACY_FULFILLMENT_DISABLED,
  LegacyFulfillmentDisabledError,
} from '@/lib/orders/fulfillment/legacy-fulfillment-disabled';

/**
 * 発送の画面が開いた時に読む材料（グループ E-1 設計書 6-1・6-2）。
 * G-1 Task 14: 旧の発送の操作を止めたので、材料も読まない。注文・要対応・商品の行・発送・配送の集計の DB の読取は全部 0 回で、
 * 呼ばれたら LegacyFulfillmentDisabledError（LEGACY_FULFILLMENT_DISABLED）を投げる。HTTP の 410 は窓口（route）が返す。
 * 形（引数と戻り値の型）は呼び手の型のために残し、G-3 の新しい発送票の材料で置き換える。
 */
export const loadFulfillmentMaterials: (client: SupabaseClient, orderId: string) => Promise<FulfillmentMaterials | null> =
  async () => {
    throw new LegacyFulfillmentDisabledError(LEGACY_FULFILLMENT_DISABLED);
  };
