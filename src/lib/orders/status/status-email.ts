import 'server-only';
import { checkSiteUrlForEmail } from '@/lib/site-url-guard';
import { ensureOrderStatusLink, type OrderStatusStore } from '@/lib/orders/status/status-store';

/**
 * 注文メールの「ご注文の状況はこちら」に入れるURL（グループ E-5 計画 P12・C-2）。
 * リンクは DB の関数で用意する（1注文1本。あれば同じトークンが返り、作り直さない）。
 * URL は、サイトの住所を基にした /order-status/{トークン} の絶対URL。
 * サイトの住所が壊れている・http でも https でもない時は、例外にせず null（材料不足）を返し、使えないURLのためにリンクを作らない。
 * DB の失敗は null にせず、固定の OrderStatusStoreError のまま投げる（worker が一時的な失敗としてやり直す）。
 * トークンと URL はログに出さない。
 */
export async function loadOrderStatusEmailUrl(store: OrderStatusStore, orderId: string): Promise<string | null> {
  const site = siteOrigin();
  if (!site) {
    return null;
  }
  const token = await ensureOrderStatusLink(store, orderId);
  return new URL(`/order-status/${token}`, site).toString();
}

function siteOrigin(): URL | null {
  const checked = checkSiteUrlForEmail();
  if (!checked.ok) return null;
  try {
    const site = new URL(checked.origin);
    return site.protocol === 'http:' || site.protocol === 'https:' ? site : null;
  } catch {
    return null;
  }
}
