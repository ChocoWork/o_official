// File: src/app/admin/purchase-orders/[id]/page.tsx
import PurchaseOrderDetailSection from '@/components/PurchaseOrderDetailSection';
import { isPurchaseOrderCreatedQuery } from '@/lib/purchase-orders/purchase-order-types';

/**
 * 発注書の詳細。作成の直後は発注の画面が目印つき（?created=1）で移してくるので、目印があれば部品が通知を出す
 * （番号は URL に載せず、部品が読んだ発注書の番号を使う）。表示の可否は部品の GET の成功で決める。
 */
export default async function PurchaseOrderDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const { id } = await params;
  const created = isPurchaseOrderCreatedQuery(await searchParams);
  return (
    <main className="mx-auto w-full min-w-0 max-w-6xl px-4 py-8 md:px-8">
      <PurchaseOrderDetailSection purchaseOrderId={id} created={created} />
    </main>
  );
}
