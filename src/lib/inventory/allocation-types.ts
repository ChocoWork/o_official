export const ALLOCATION_EVENT_LABELS = {
  hold: '支払い前の仮確保',
  promote: '入金による割当への切替',
  allocate: '注文への割当',
  release: '割当の解放',
  consume: '発送による割当の消費',
  restore: '発送取消による割当の復元',
  transfer: '割当の入替',
} as const;

export type AllocationHistoryEvent = {
  id: string;
  allocationId: string;
  orderId: string;
  orderItemId: string;
  variantId: number;
  type: keyof typeof ALLOCATION_EVENT_LABELS;
  quantity: number;
  operationId: string;
  counterpartAllocationId: string | null;
  reversesEventId: string | null;
  stockMovementId: string | null;
  reason: string | null;
  actorId: string | null;
  createdAt: string;
};

export type StockMovementInput = {
  itemId: number;
  variantId: number;
  delta: number;
  reason: 'restock' | 'adjustment';
  note: string | null;
  requestKey: string;
  expectedReleaseQuantity: number | null;
};
export type StockMovementResult = {
  movementId: string;
  releasedQuantity: number;
  allocatedQuantity: number;
  replayed: boolean;
};
export type VariantInventory = {
  variant_id: number;
  free: number;
  paid_allocated: number;
  payment_held: number;
  on_hand: number;
  waiting: number;
};
