// File: src/app/admin/shipment-slips/[id]/page.tsx
import ShipmentSlipSection from '@/components/ShipmentSlipSection';

/** 発送票の頁。表示の可否は部品の GET の成功で決める（権限は窓口と DB が守る）。 */
export default async function ShipmentSlipPage({ params }: { params: Promise<{ id: string }> }): Promise<React.JSX.Element> {
  const { id } = await params;
  return (
    <main className="mx-auto w-full min-w-0 max-w-6xl px-4 py-8 md:px-8">
      <ShipmentSlipSection slipId={id} />
    </main>
  );
}
