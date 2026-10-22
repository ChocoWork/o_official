// File: src/app/order-status/[token]/page.tsx
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { connection } from 'next/server';
import { OrderStatusPublic } from '@/features/order-status/components/OrderStatusPublic';
import { OrderStatusAccess } from '@/features/order-status/components/OrderStatusAccess';
import { buildCustomerOrderPublicView } from '@/lib/orders/customer-order-view';
import { ORDER_STATUS_TEXT } from '@/lib/orders/status/status-messages';
import { isOrderStatusToken } from '@/lib/orders/status/status-token';
import { getOrderStatusLink, loadOrderStatusPublicMaterial, loadOrderStatusReturns } from '@/lib/orders/status/status-store';
import { isDeliveryTrackingKeyConfigured } from '@/lib/orders/tracking/delivery-config';
import { signItemImageUrl } from '@/lib/storage/item-images';
import { createServiceRoleClient } from '@/lib/supabase/server';
import '@/app/account/account.css';

export const metadata: Metadata = {
  title: ORDER_STATUS_TEXT.metadataTitle,
  robots: { index: false, follow: false },
};

/** 公開専用の材料だけを要求時に読む。確認印や個人情報はここへ運ばない。 */
export default async function OrderStatusPage({ params }: { params: Promise<{ token: string }> }): Promise<React.JSX.Element> {
  const { token } = await params;
  if (!isOrderStatusToken(token)) notFound();
  await connection();
  // notFound の例外を障害へ写さないよう、読取と404の判定を分ける。
  const view = await (async () => {
    try {
      const store = await createServiceRoleClient();
      const link = await getOrderStatusLink(store, token);
      if (!link) return null;
      const material = await loadOrderStatusPublicMaterial(store, link.orderId);
      if (!material) return null;
      const returnSection = await loadOrderStatusReturns(store, { orderId: link.orderId, includePrivate: false })
        .catch(() => {
          // 返品の欄だけが消える障害に運用で気づけるよう、固定の記号だけ残す（エラーの中身・トークン・値は出さない）
          console.error('ORDER_STATUS_FAILED');
          return null;
        });
      return await buildCustomerOrderPublicView({
        ...material, returnSection, trackingKeyConfigured: isDeliveryTrackingKeyConfigured(process.env),
        signImage: (path) => signItemImageUrl(store, path),
      });
    } catch {
      console.error('ORDER_STATUS_FAILED');
      throw new Error('ORDER_STATUS_FAILED');
    }
  })();
  if (!view) notFound();
  return (
    <main className="account-page max-w-6xl mx-auto px-4 sm:px-6 py-10 space-y-6 min-w-0 break-words">
      <OrderStatusPublic view={view} />
      <OrderStatusAccess token={token} orderId={view.id} orderNumber={view.orderNumber} publicReturns={view.returnSection?.returns ?? []} />
    </main>
  );
}
