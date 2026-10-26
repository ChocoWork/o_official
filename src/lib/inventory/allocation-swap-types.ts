import { z } from 'zod';

/** DB message / SQLSTATE の完全一致だけで公開する。内部エラーはこの表へ足さない。 */
export const ALLOCATION_SWAP_ERRORS: Record<string, readonly [sqlstate: string, status: number, body: string]> = {
  GROUP_G_ARGUMENT_INVALID: ['22023', 400, '入力を確かめてください。'],
  GROUP_G_FORBIDDEN: ['42501', 403, '割り当てを入れ替える権限がありません。'],
  GROUP_G_REQUEST_KEY_CONFLICT: ['23505', 409, '同じ要求番号で異なる操作は実行できません。'],
  GROUP_G_SWAP_REASON_REQUIRED: ['22023', 400, '理由を入力してください。'],
  GROUP_G_SWAP_ITEM_NOT_FOUND: ['P0002', 404, '品物が見つかりません。'],
  GROUP_G_SWAP_SAME_ORDER: ['22023', 409, '同じ注文の品物どうしでは入れ替えられません。'],
  GROUP_G_SWAP_VARIANT_MISMATCH: ['22023', 409, '色・サイズが同じ品物どうしだけ入れ替えられます。'],
  GROUP_G_SWAP_ORDER_NOT_PAID: ['22023', 409, '入金が確認できていない注文は入れ替えられません。'],
  GROUP_G_SWAP_TAKER_ON_HOLD: ['22023', 409, '支払額の確認または交換手数料のお支払いを待っている品物には割り当てられません。'],
  GROUP_G_SWAP_DONOR_PENDING_REQUEST: ['22023', 409, 'キャンセルの申し込みか返金の処理中の数がある品物の割当は入れ替えられません。'],
  GROUP_G_SWAP_DONOR_ON_HOLD: ['22023', 409, '支払額の確認などで止まっている割当は入れ替えられません。'],
  GROUP_G_SWAP_QUANTITY_EXCEEDS_TAKER: ['22023', 409, '割り当てを受ける品物の、受注生産中の数を超えています。'],
  GROUP_G_SWAP_QUANTITY_EXCEEDS_DONOR: ['22023', 409, '割当元の、発送準備中の数を超えています。'],
};

export const ALLOCATION_SWAP_TEXT = {
  title: (orderNumber: string): string => `割り当てを入れ替える（注文 ${orderNumber}）`,
  description: '他の注文の発送準備中の割当を、この注文の受注生産中の品物へ移します。在庫の総数は変わりません。',
  donorLabel: '割当元の注文', quantityLabel: '数量', reasonLabel: '理由',
  reasonHelp: 'この理由は両方の注文の履歴に残ります。', submit: '入れ替える', back: '戻る',
  candidatesEmpty: '入れ替えられる割当がありません。', candidatesLoading: '候補を読み込み中です...', candidatesFailed: '候補を読み込めませんでした。',
  success: '割当を入れ替えました。', failed: '割当の入替に失敗しました。',
  forbidden: '割り当てを入れ替える権限がありません。',
  csrfFailed: '操作の確認ができませんでした。ページを読み込み直してから、もう一度お試しください。',
  checkAgain: 'もう一度確かめる',
  unknown: '結果を確かめられませんでした。「もう一度確かめる」を押すと、二重にならずに確かめ直します。',
} as const;

export type AllocationSwapInput = { takerOrderItemId: string; donorOrderItemId: string; quantity: number; reason: string; requestKey: string };
export type AllocationSwapResult = {
  id: string; operationId: string; takerOrderId: string; takerOrderItemId: string;
  donorOrderId: string; donorOrderItemId: string; quantity: number; reason: string; replayed: boolean;
};
export type AllocationSwapCandidate = { donorOrderId: string; donorOrderItemId: string; orderCreatedAt: string; swappableQuantity: number; takerQuantity: number };

export const allocationSwapInputSchema = z.object({
  takerOrderItemId: z.string().uuid(), donorOrderItemId: z.string().uuid(),
  quantity: z.number().int().min(1).max(99999), reason: z.string().trim().min(1).max(200), requestKey: z.string().uuid(),
}).strict();
const resultSchema = z.object({
  id: z.string().uuid(), operationId: z.string().uuid(), takerOrderId: z.string().uuid(), takerOrderItemId: z.string().uuid(),
  donorOrderId: z.string().uuid(), donorOrderItemId: z.string().uuid(), quantity: z.number().int().min(1).max(99999),
  reason: z.string().min(1).max(200), replayed: z.boolean(),
}).strict();
const candidateSchema = z.object({
  donorOrderId: z.string().uuid(), donorOrderItemId: z.string().uuid(), orderCreatedAt: z.string().datetime({ offset: true }),
  swappableQuantity: z.number().int().positive().safe(), takerQuantity: z.number().int().positive().safe(),
}).strict();
const sameId = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/** 形だけ合う別操作の応答を成功として扱わないため、送った対象と内容も突き合わせる。 */
export function parseAllocationSwapResult(raw: unknown, orderId: string, input: AllocationSwapInput): AllocationSwapResult {
  const result = resultSchema.parse(raw);
  if (!sameId(result.id, orderId) || !sameId(result.takerOrderId, orderId)
    || !sameId(result.takerOrderItemId, input.takerOrderItemId) || !sameId(result.donorOrderItemId, input.donorOrderItemId)
    || sameId(result.donorOrderId, orderId) || sameId(result.donorOrderItemId, result.takerOrderItemId)
    || result.quantity !== input.quantity || result.reason !== input.reason.trim()) throw new Error('ALLOCATION_SWAP_RESULT_INVALID');
  return result;
}

/** DB の50候補の上限、同じT、重複なしを検査し、不正な結果を黙って切らない。 */
export function parseAllocationSwapCandidates(raw: unknown, orderId: string): AllocationSwapCandidate[] {
  const rows = z.array(candidateSchema).max(50).parse(raw);
  const seen = new Set<string>();
  for (const row of rows) {
    const key = row.donorOrderItemId.toLowerCase();
    if (sameId(row.donorOrderId, orderId) || seen.has(key) || row.takerQuantity !== rows[0].takerQuantity) throw new Error('ALLOCATION_SWAP_RESULT_INVALID');
    seen.add(key);
  }
  return rows;
}
