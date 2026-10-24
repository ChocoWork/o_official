// File: src/app/admin/purchase-orders/documents/page.tsx
import PurchaseOrderDocumentSearchSection from '@/components/PurchaseOrderDocumentSearchSection';

/** 取引書類の検索。表示の可否は部品の GET の成功で決める（権限は窓口と DB が守る）。 */
export default function PurchaseOrderDocumentSearchPage(): React.JSX.Element {
  return (
    <main className="mx-auto w-full min-w-0 max-w-6xl px-4 py-8 md:px-8">
      <PurchaseOrderDocumentSearchSection />
    </main>
  );
}
