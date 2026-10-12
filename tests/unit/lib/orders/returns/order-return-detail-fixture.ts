import type { OrderReturnDetail } from '@/lib/orders/returns/return-types';

type ReturnDetailOverrides = Omit<Partial<OrderReturnDetail>, 'fees'> & { fees?: Partial<OrderReturnDetail['fees']> };

/**
 * 返品1件の見本（共通の約束 C-2 の OrderReturnDetail を全部埋めた物。お店が作った受付中の返品で、受け取りも手数料も無い）。
 * 変えたい欄だけ渡す。fees は欄ごとに上書きできる。窓口と画面の試験が、返品の一覧（listOrderReturns）の答えの見本に使う
 */
export function returnDetail(overrides: ReturnDetailOverrides = {}): OrderReturnDetail {
  const { fees, ...rest } = overrides;
  return {
    id: 'ret-1',
    number: 1,
    label: 'ORD-A1B2C3D4-R1',
    status: 'open',
    source: 'shop',
    displayStatus: 'in_progress',
    marks: [],
    returnMethod: 'customer_ships',
    returnShippingPayer: 'customer',
    returnCarrier: null,
    returnTrackingNumber: null,
    firstReceiptDone: false,
    firstExchangeReceiptDone: false,
    shopNote: null,
    notifyCustomer: true,
    createdAt: '2026-10-12T01:00:00.000Z',
    createdByEmail: 'admin@example.com',
    closedAt: null,
    cancelledAt: null,
    lines: [],
    refunds: [],
    receipts: [],
    exchangeItems: [],
    ...rest,
    fees: {
      returnShippingFee: 0,
      restockingFeePercent: 0,
      exchangeFee: 0,
      exchangeShippingFee: 0,
      feeDueAmount: 0,
      feePendingDeduction: 0,
      feeReceivedAt: null,
      exchangeReleasedAt: null,
      ...fees,
    },
  };
}
