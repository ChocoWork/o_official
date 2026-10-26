import AdminOrderItemListSection from '@/components/AdminOrderItemListSection';

/** 注文一覧表（G-4）。表示の可否は GET の成功で決める（権限は窓口と DB が守る）。 */
export default function AdminOrdersPage(): React.JSX.Element {
  return (
    <main className="mx-auto w-full min-w-0 max-w-6xl px-4 py-8 md:px-8">
      <AdminOrderItemListSection />
    </main>
  );
}
