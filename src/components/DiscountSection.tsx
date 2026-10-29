'use client';

// File: src/components/DiscountSection.tsx
// 管理画面の DISCOUNT タブ（グループ H / FREQ-547）。割引の一覧と、作成の頁への入口。
// 店長とサポートの人の両方に出す。権限の無い人には一覧が権限の文を出す（窓口 admin.discounts.read が守る）。
import { useRouter } from 'next/navigation';
import DiscountList from '@/features/discounts/components/DiscountList';

export default function DiscountSection(): React.JSX.Element {
  const router = useRouter();
  return (
    <DiscountList
      onOpen={(id) => router.push(`/admin/discounts/${id}`)}
      onCreate={() => router.push('/admin/discounts/new')}
    />
  );
}
