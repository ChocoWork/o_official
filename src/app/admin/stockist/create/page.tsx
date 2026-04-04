'use client';

import { StockistForm } from '../StockistForm';

export default function AdminStockistCreatePage() {
  return <StockistForm submitUrl="/api/admin/stockists" submitMethod="POST" />;
}
