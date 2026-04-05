import { PublicStockistGrid } from '@/features/stockist/components/PublicStockistGrid';

export default function StockistPage() {
  return (
    <div className="pb-10 sm:pb-14 px-6 lg:px-12">
      <div className="max-w-7xl mx-auto">
        <PublicStockistGrid variant="catalog"/>
      </div>
    </div>
  );
}