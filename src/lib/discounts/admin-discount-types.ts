import type { DiscountDefinition, DiscountKind, DiscountMethod } from './discount-types';

/**
 * DB message / SQLSTATE の完全一致だけで公開する。内部エラーはこの表へ足さない。
 * 未知の失敗は GROUP_H_TEXT.failed の500にする。
 */
export const GROUP_H_ERRORS = {
  GROUP_H_ARGUMENT_INVALID: ['22023', 400, '入力を確かめてください。'],
  GROUP_H_FORBIDDEN: ['42501', 403, '割引を操作する権限がありません。'],
  GROUP_H_DISCOUNT_NOT_FOUND: ['P0002', 404, '割引が見つかりません。'],
  GROUP_H_CODE_CONFLICT: ['23505', 409, 'このコードは既に使われています。'],
  GROUP_H_VERSION_CONFLICT: ['40001', 409, '設定が変わりました。読み直してください。'],
  GROUP_H_USED_FIELDS_LOCKED: ['55000', 409, '使用後はこの項目を変更できません。複製して新しく作ってください。'],
  GROUP_H_ASSIGNMENT_USED: ['55000', 409, '使用済みの割り当ては外せません。'],
  GROUP_H_AUTOMATIC_LIMIT: ['23514', 409, '同時に有効にできる自動の割引は25件までです。'],
  GROUP_H_STACKABLE_AUTOMATIC_LIMIT: ['23514', 409, '重ねられる自動の割引は、商品の割引と注文の割引でそれぞれ6件までです。'],
  GROUP_H_STACKABLE_SET_ITEM_CONFLICT: ['23514', 409, '同じ服を含むセット割引は、同じ期間に重ねる設定にできません。'],
  GROUP_H_REQUEST_KEY_CONFLICT: ['23505', 409, '同じ要求番号で異なる操作は実行できません。'],
  GROUP_H_CODE_GENERATION_FAILED: ['54000', 503, 'コードを作れませんでした。もう一度お試しください。'],
  GROUP_H_DRAFT_SNAPSHOT_CONFLICT: ['22023', 409, '割引の条件が変わりました。入力画面で割引を確かめてください。'],
  GROUP_H_LOCK_REQUIRED: ['55000', 500, '割引の処理に失敗しました。'],
  GROUP_H_REFUND_UNIT_MISMATCH: ['23514', 500, '返金額を確かめられませんでした。読み直してからお試しください。'],
} as const satisfies Readonly<Record<string, readonly [sqlstate: string, status: number, message: string]>>;

export type GroupHErrorCode = keyof typeof GROUP_H_ERRORS;

export const GROUP_H_TEXT = {
  failed: '割引の処理に失敗しました。',
  invalid: '入力を確かめてください。',
} as const;

/** 保存前の有効数検査が返す固定コード。DB の同名コードと文が一致する。 */
export type DiscountActivationCode = 'GROUP_H_AUTOMATIC_LIMIT' | 'GROUP_H_STACKABLE_AUTOMATIC_LIMIT' | 'GROUP_H_STACKABLE_SET_ITEM_CONFLICT';

export type DiscountCreateInput = Omit<DiscountDefinition, 'id' | 'version'> & {
  code: string | null; codeMode: 'shared' | 'batch'; initialBatch?: { prefix: string; userIds: string[]; count: number };
};
export type DiscountPatch = Partial<Omit<DiscountCreateInput, 'codeMode' | 'initialBatch'>> | { acknowledgeSearchAttention: true };
export type DiscountListStatus = 'scheduled' | 'active' | 'expired' | 'stopped';
export type DiscountFilters = { status?: DiscountListStatus; kind?: DiscountKind; method?: DiscountMethod; query?: string };
export type DiscountSearchAttention = { openedAt: string; count: number };
export type DiscountListRow = {
  id: string; name: string; kind: DiscountKind; method: DiscountMethod; status: DiscountListStatus;
  startsAt: string; endsAt: string | null; usedCount: number; usageLimit: number | null; searchAttention: DiscountSearchAttention | null;
};
export type DiscountAssignmentRow = {
  rowId: string; codeId: string; code: string; userId: string | null; assigneeDeleted: boolean; assigneeName: string | null;
  guestEmailMasked: string | null; status: 'unused' | 'reserved' | 'confirmed'; usedAt: string | null; orderId: string | null;
};
export type DiscountPermissions = { read: boolean; manage: boolean };
export type AdminDiscountCode = {
  codeId: string; code: string; singleUse: boolean; audience: 'assigned' | 'anyone'; allowGuests: boolean; assignedUserId: string | null;
};
export type AdminDiscountDetail = {
  codes: AdminDiscountCode[];
  discount: DiscountDefinition; used: boolean; assignmentTotal: number; assignments: DiscountAssignmentRow[];
  searchAttention: DiscountSearchAttention | null; permissions: DiscountPermissions;
};
/** storeはactorの画面権限を知らない。routeが permissions を足して AdminDiscountDetail にする。 */
export type AdminDiscountDetailData = Omit<AdminDiscountDetail, 'permissions'>;
export type DiscountWriteResult = { discountId: string; version: string; replayed: boolean };
export type DiscountAssignmentResult = { discountId: string; changedCount: number; replayed: boolean };
export type DiscountBatchResult = {
  discountId: string; batchId: string; codes: { codeId: string; code: string; userId: string | null }[]; replayed: boolean;
};
export type DiscountMember = { userId: string; name: string | null; email: string };
