import {
  PURCHASE_ORDER_CREATED_QUERY,
  PURCHASE_ORDER_DISPLAY_STAGE_LABELS,
  PURCHASE_ORDER_ERRORS,
  PURCHASE_ORDER_LIMITS,
  PURCHASE_ORDER_TEXT,
  formatPurchaseOrderCreatedNotice,
  isPurchaseOrderQuantity,
  purchaseOrderCreateFailureMessage,
  type PurchaseOrderDisplayStage,
  type PurchaseOrderStage,
} from '@/lib/purchase-orders/purchase-order-types';

describe('purchase-order-types', () => {
  test('FREQ-526-AC-01: 値の範囲は計画の共通の値と同じ（行1〜100・仮数量1〜99999・発注先1〜100・メモ0〜500）', () => {
    expect(PURCHASE_ORDER_LIMITS.lines).toEqual({ min: 1, max: 100 });
    expect(PURCHASE_ORDER_LIMITS.provisionalQuantity).toEqual({ min: 1, max: 99999 });
    expect(PURCHASE_ORDER_LIMITS.supplierName).toEqual({ min: 1, max: 100 });
    expect(PURCHASE_ORDER_LIMITS.memo).toEqual({ min: 0, max: 500 });
  });

  test('FREQ-526-AC-01: 保存する段階は2つ、表示する段階は5つで、表示の文は計画のとおり', () => {
    const stored: PurchaseOrderStage[] = ['ordered', 'quantity_confirmed'];
    const displayed: PurchaseOrderDisplayStage[] = ['ordered', 'quantity_confirmed', 'partially_received', 'received', 'closed'];
    expect(stored).toHaveLength(2);
    expect(Object.keys(PURCHASE_ORDER_DISPLAY_STAGE_LABELS)).toEqual(displayed);
    expect(PURCHASE_ORDER_DISPLAY_STAGE_LABELS).toEqual({
      ordered: '数量確定待ち',
      quantity_confirmed: '数量確定済み・受け取り待ち',
      partially_received: '一部受け取り済み',
      received: '受け取り完了',
      closed: '完了（残りを打ち切り）',
    });
  });

  test('FREQ-526-AC-02: DB エラー表は message → [SQLSTATE, 状態, 本文] で、表の本文は空でなく重複もない', () => {
    for (const [message, [sqlstate, status, body]] of Object.entries(PURCHASE_ORDER_ERRORS)) {
      expect(message).toMatch(/^GROUP_G_[A-Z_]+$/);
      expect(sqlstate).toMatch(/^[0-9A-Z]{5}$/);
      expect(status).toBeGreaterThanOrEqual(400);
      expect(status).toBeLessThan(500);
      expect(body.length).toBeGreaterThan(0);
    }
    const bodies = Object.values(PURCHASE_ORDER_ERRORS).map(([, , body]) => body);
    expect(new Set(bodies).size).toBe(bodies.length);
  });

  test('FREQ-526-AC-01: 通知の文は「発注書 ${number} を作成しました。数量が確定するまで受け取りはできません。」で、発注書の頁へ渡す目印は created=1', () => {
    expect(formatPurchaseOrderCreatedNotice('PO-20261025-0001'))
      .toBe('発注書 PO-20261025-0001 を作成しました。数量が確定するまで受け取りはできません。');
    expect(PURCHASE_ORDER_CREATED_QUERY).toBe('created=1');
  });

  test.each([
    ['1', true], ['99999', true], ['5', true],
    ['', false], ['0', false], ['-1', false], ['1.5', false], ['abc', false], ['100000', false], ['01', false], ['1e3', false],
    [' 7 ', false],
  ])('FREQ-526-AC-01: 発注数量の入力 %j が正の整数（1〜99999）か: %s', (value, expected) => {
    expect(isPurchaseOrderQuantity(value)).toBe(expected);
  });

  test('FREQ-526-AC-01: 固定の文（権限・発注先の必須・失敗）は計画のとおり', () => {
    expect(PURCHASE_ORDER_TEXT.forbidden).toBe('発注を扱う権限がありません。');
    expect(PURCHASE_ORDER_TEXT.supplierRequired).toBe('発注先を入力してください。');
    expect(PURCHASE_ORDER_TEXT.failed).toBe('発注の記録に失敗しました');
  });

  test('FREQ-526-AC-01: 失敗の文: DB エラー表の本文 → MFA → 401 → 403 の権限の文 → 400 → その他の順', () => {
    expect(purchaseOrderCreateFailureMessage(409, { code: 'GROUP_G_REQUEST_KEY_CONFLICT', error: '同じ要求番号で異なる操作は実行できません。' }))
      .toBe('同じ要求番号で異なる操作は実行できません。');
    // DB が断った 403 も窓口の本文（表の文）をそのまま出す
    expect(purchaseOrderCreateFailureMessage(403, { code: 'GROUP_G_FORBIDDEN', error: '発注を扱う権限がありません。' }))
      .toBe('発注を扱う権限がありません。');
    expect(purchaseOrderCreateFailureMessage(403, { error: 'Forbidden', permission: 'admin.purchase_orders.manage' }))
      .toBe('発注を扱う権限がありません。');
    expect(purchaseOrderCreateFailureMessage(403, { error: 'Forbidden', reason: 'MFA required' })).toBe('2要素認証が必要です');
    expect(purchaseOrderCreateFailureMessage(401, { error: 'Unauthorized' })).toBe('ログインし直してください。');
    expect(purchaseOrderCreateFailureMessage(400, { error: 'Invalid request', details: {} })).toBe('入力を確かめてください。');
    expect(purchaseOrderCreateFailureMessage(500, { error: '発注の記録に失敗しました' })).toBe('発注の記録に失敗しました');
    expect(purchaseOrderCreateFailureMessage(500, null)).toBe('発注の記録に失敗しました');
    // 表に無い code の本文は出さない（生の文を画面へ流さない）
    expect(purchaseOrderCreateFailureMessage(500, { code: 'PRIVATE-MARKER', error: 'PRIVATE-MARKER' })).toBe('発注の記録に失敗しました');
  });
});
