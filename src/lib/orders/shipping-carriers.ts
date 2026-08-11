/**
 * 配送業者のラベルと追跡URL。
 *
 * URL の形式は業者都合で変わるのでコードで管理し、デプロイで直す。
 * DB にマスタを持つと管理UIが要るが、業者は年に何度も増えない。
 */
export type ShippingCarrierId = 'yamato' | 'sagawa' | 'japanpost';

export const SHIPPING_CARRIER_IDS = ['yamato', 'sagawa', 'japanpost'] as const;

export const SHIPPING_CARRIERS: Record<
  ShippingCarrierId,
  { label: string; trackingUrl: (trackingNumber: string) => string }
> = {
  yamato: {
    label: 'ヤマト運輸',
    trackingUrl: (n) =>
      `https://toi.kuronekoyamato.co.jp/cgi-bin/tneko?number=${encodeURIComponent(n)}`,
  },
  sagawa: {
    label: '佐川急便',
    trackingUrl: (n) =>
      `https://k2k.sagawa-exp.co.jp/p/web/okurijosearch.do?okurijoNo=${encodeURIComponent(n)}`,
  },
  japanpost: {
    label: '日本郵便',
    trackingUrl: (n) =>
      `https://trackings.post.japanpost.jp/services/srv/search/direct?reqCodeNo1=${encodeURIComponent(n)}&searchKind=S002&locale=ja`,
  },
};

export function isShippingCarrierId(value: unknown): value is ShippingCarrierId {
  return typeof value === 'string' && (SHIPPING_CARRIER_IDS as readonly string[]).includes(value);
}
