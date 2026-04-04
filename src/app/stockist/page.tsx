import { PublicStockistGrid } from '@/features/stockist/components/PublicStockistGrid';

export default function StockistPage() {
  return (
    <main className="pt-32 pb-20 px-6 lg:px-12">
      <div className="max-w-7xl mx-auto">
        <PublicStockistGrid variant="catalog"/>
      </div>
    </main>
  );
}