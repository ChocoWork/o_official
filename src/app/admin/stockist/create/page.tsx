/**
 * 取扱店の作成のページ（src/app/admin/stockist/create/page.tsx）。
 *
 * @packageDocumentation
 * @impl IMPL-STOCKIST-123
 * @design DD-STOCKIST-032
 * @remarks 作成と編集の決まりを共通のフォーム1つに置くため、この頁は作成の送り先と POST を渡すだけにする（SCR-STOCKIST-005）。管理のタブの「新規作成」から入る（FLOW-STOCKIST-002）。
 */
'use client';

import { StockistForm } from '../StockistForm';

export default function AdminStockistCreatePage() {
  return <StockistForm submitUrl="/api/admin/stockists" submitMethod="POST" />;
}
