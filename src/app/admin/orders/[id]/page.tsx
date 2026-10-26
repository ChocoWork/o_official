import AdminOrderDetailSection from '@/components/AdminOrderDetailSection';

export default async function AdminOrderDetailPage({ params }: { params: Promise<{ id: string }> }): Promise<React.JSX.Element> {
  const { id } = await params;
  return (
    <main className="mx-auto w-full min-w-0 max-w-6xl px-4 py-8 md:px-8">
      <AdminOrderDetailSection orderId={id} />
    </main>
  );
}
