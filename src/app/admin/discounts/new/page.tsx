import DiscountFormScreen from '@/features/discounts/components/DiscountFormScreen';

/** 割引を作る（グループ H）。保存の可否は窓口（admin.discounts.manage）と DB が決める。 */
export default function AdminDiscountNewPage(): React.JSX.Element {
  return (
    <main className="mx-auto w-full min-w-0 max-w-6xl px-4 py-8 md:px-8">
      <DiscountFormScreen />
    </main>
  );
}
