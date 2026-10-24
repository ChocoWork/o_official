// File: src/app/admin/inventory/page.tsx
import AdminInventorySection from '@/components/AdminInventorySection';

/** 表示の可否は部品の GET の成功で決める（権限は窓口と DB が守る）。 */
export default function AdminInventoryPage(): React.JSX.Element {
  return (
    <main className="mx-auto w-full min-w-0 max-w-6xl px-4 py-8 md:px-8">
      <AdminInventorySection />
    </main>
  );
}
