import DiscountDetail from '@/features/discounts/components/DiscountDetail';

/** 割引の詳細（グループ H）。表示の可否は GET の成功で決める（権限は窓口と DB が守る）。 */
export default async function AdminDiscountDetailPage({ params }: { params: Promise<{ id: string }> }): Promise<React.JSX.Element> {
  const { id } = await params;
  return (
    <main className="mx-auto w-full min-w-0 max-w-6xl px-4 py-8 md:px-8">
      <DiscountDetail key={id} discountId={id} />
    </main>
  );
}
