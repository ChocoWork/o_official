import DiscountFormScreen from '@/features/discounts/components/DiscountFormScreen';

/** 割引を変える（グループ H）。使った後に変えられる欄は DiscountForm と窓口・DB が同じ規則で決める。 */
export default async function AdminDiscountEditPage({ params }: { params: Promise<{ id: string }> }): Promise<React.JSX.Element> {
  const { id } = await params;
  return (
    <main className="mx-auto w-full min-w-0 max-w-6xl px-4 py-8 md:px-8">
      <DiscountFormScreen key={id} discountId={id} />
    </main>
  );
}
