import {
  PURCHASE_ORDER_CREATED_QUERY,
  PURCHASE_ORDER_DETAIL_TEXT,
  PURCHASE_ORDER_DISPLAY_STAGE_LABELS,
  PURCHASE_ORDER_ERRORS,
  PURCHASE_ORDER_LIMITS,
  PURCHASE_ORDER_LIST_TEXT,
  PURCHASE_ORDER_READ_FAILED,
  PURCHASE_ORDER_TEXT,
  formatPurchaseOrderCreatedNotice,
  formatPurchaseOrderDate,
  formatPurchaseOrderDateTime,
  formatPurchaseOrderDay,
  formatYen,
  isPurchaseOrderCreatedQuery,
  isPurchaseOrderQuantity,
  parsePurchaseOrderDetail,
  parsePurchaseOrderListRow,
  purchaseOrderCreateFailureMessage,
  type PurchaseOrderDisplayStage,
  type PurchaseOrderStage,
} from '@/lib/purchase-orders/purchase-order-types';
import { confirmedDetail, listRow, orderedDetail } from './purchase-order-fixtures';

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

describe('purchase-order-types: 発注一覧表・発注書の詳細の読取（Task 5）', () => {
  const clone = () => JSON.parse(JSON.stringify(confirmedDetail())) as any;

  test('FREQ-526-AC-04: 発注一覧表の固定の文は計画のとおり', () => {
    expect(PURCHASE_ORDER_LIST_TEXT).toMatchObject({
      heading: '発注一覧表',
      empty: '発注書はまだありません。',
      forbidden: '発注一覧を見る権限がありません。',
      failed: '発注一覧を読み込めませんでした。時間をおいて再度お試しください。',
      unconfirmed: '数量未確定',
    });
  });

  test('FREQ-526-AC-05: 発注書の詳細の固定の文は、見つからない時が計画の文、見積額の注記が「税の扱いは書類に従います」', () => {
    expect(PURCHASE_ORDER_DETAIL_TEXT.notFound).toBe('発注書が見つかりません。');
    expect(PURCHASE_ORDER_DETAIL_TEXT.taxNote).toBe('税の扱いは書類に従います');
    expect(PURCHASE_ORDER_DETAIL_TEXT.priceMissing).toBe('単価未登録');
    expect(PURCHASE_ORDER_DETAIL_TEXT.documentMissing).toBe('証憑未添付');
  });

  test('FREQ-526-AC-05: 読取の失敗は内部の印 PURCHASE_ORDER_READ_FAILED', () => {
    expect(PURCHASE_ORDER_READ_FAILED).toBe('PURCHASE_ORDER_READ_FAILED');
  });

  test('FREQ-526-AC-05: parsePurchaseOrderDetail は数量確定済みの発注書をそのままの形で返す', () => {
    expect(parsePurchaseOrderDetail(confirmedDetail())).toEqual(confirmedDetail());
  });

  test('FREQ-526-AC-05: parsePurchaseOrderDetail は数量確定前の発注書（確定数量・未納・単価が無い）を返す', () => {
    const parsed = parsePurchaseOrderDetail(orderedDetail());
    expect(parsed).toEqual(orderedDetail());
    expect(parsed.lines.map((line) => [line.orderQuantity, line.outstandingQuantity, line.unitPriceYen])).toEqual([[null, null, null], [null, null, null]]);
  });

  test('FREQ-526-AC-05: 知らない項目（保存先の鍵・内部の操作ID）は戻りに含めない', () => {
    const raw = clone();
    raw.storage_path = 'PRIVATE-MARKER';
    raw.operationId = 'PRIVATE-MARKER';
    raw.attachments[0].storagePath = 'PRIVATE-MARKER';
    raw.attachments[0].operationId = 'PRIVATE-MARKER';
    raw.revisions[0].operationId = 'PRIVATE-MARKER';
    raw.lines[0].internal = 'PRIVATE-MARKER';
    expect(JSON.stringify(parsePurchaseOrderDetail(raw))).not.toContain('PRIVATE-MARKER');
    expect(parsePurchaseOrderDetail(raw)).toEqual(confirmedDetail());
  });

  const BROKEN: Array<[string, (detail: any) => unknown]> = [
    ['null', () => null],
    ['配列', () => []],
    ['文字列', () => 'PRIVATE-MARKER'],
    ['id が uuid でない', (d) => { d.id = 'abc'; return d; }],
    ['number の形が違う', (d) => { d.number = 'PO-2026-1'; return d; }],
    ['発注先が文字列でない', (d) => { d.supplierName = 5; return d; }],
    ['メモが文字列でも null でもない', (d) => { d.memo = 5; return d; }],
    ['未知の保存段階', (d) => { d.stage = 'draft'; return d; }],
    ['未知の表示段階', (d) => { d.displayStage = 'cancelled'; return d; }],
    ['保存段階 ordered なのに表示段階が受け取り済み', (d) => { d.stage = 'ordered'; return d; }],
    ['保存段階が確定済みなのに表示段階が ordered', (d) => { d.displayStage = 'ordered'; return d; }],
    ['版が0', (d) => { d.version = 0; return d; }],
    ['版が小数', (d) => { d.version = 1.5; return d; }],
    ['発注日時が日付でない', (d) => { d.orderedAt = 'いつか'; return d; }],
    ['作成者が uuid でない', (d) => { d.createdBy = 'abc'; return d; }],
    ['lines が配列でない', (d) => { d.lines = {}; return d; }],
    ['行の納品済みが負', (d) => { d.lines[0].receivedQuantity = -1; return d; }],
    ['行の確定数量が小数', (d) => { d.lines[0].orderQuantity = 2.5; return d; }],
    ['行の確定数量が文字列', (d) => { d.lines[0].orderQuantity = '5'; return d; }],
    ['行の確定数量が無いのに未納がある', (d) => { d.lines[0].orderQuantity = null; return d; }],
    ['行の確定数量があるのに未納が無い', (d) => { d.lines[0].outstandingQuantity = null; return d; }],
    ['行の未納が 確定数量 − 納品済み と合わない', (d) => { d.lines[0].outstandingQuantity = 4; return d; }],
    ['行の単価が負', (d) => { d.lines[0].unitPriceYen = -1; return d; }],
    ['行の variantId が0', (d) => { d.lines[0].variantId = 0; return d; }],
    ['行の line_no が0', (d) => { d.lines[0].lineNo = 0; return d; }],
    ['履歴の種類が未知', (d) => { d.revisions[0].kind = 'delete'; return d; }],
    ['履歴の数量が負', (d) => { d.revisions[1].afterQuantity = -1; return d; }],
    ['履歴の版が0', (d) => { d.revisions[1].revisionNo = 0; return d; }],
    ['打切りの数量が負', (d) => { d.shortClosures[0].closedQuantity = -1; return d; }],
    ['受け取りの種類が未知', (d) => { d.receipts[0].kind = 'refund'; return d; }],
    ['受け取りの日が日付の形でない', (d) => { d.receipts[0].receivedOn = '2026/10/26'; return d; }],
    ['受取行の数量が0', (d) => { d.receipts[0].lines[0].quantity = 0; return d; }],
    ['受取行の数量が負なのに相殺の元が無い', (d) => { d.receipts[0].lines[0].quantity = -1; return d; }],
    ['受取行の取り消せる数が負', (d) => { d.receipts[0].lines[0].reversibleQuantity = -1; return d; }],
    ['受取行の取り消せる数が数量を超える', (d) => { d.receipts[0].lines[0].reversibleQuantity = 3; return d; }],
    ['書類の種類が未知', (d) => { d.attachments[0].kind = 'receipt'; return d; }],
    ['書類の sha256 が64桁でない', (d) => { d.attachments[0].sha256 = 'abc'; return d; }],
    ['書類の sha256Source が未知', (d) => { d.attachments[0].sha256Source = 'client'; return d; }],
    ['書類の大きさが負', (d) => { d.attachments[0].sizeBytes = -1; return d; }],
    ['書類の current が無い', (d) => { d.attachments[0].current = null; return d; }],
    ['書類の取引日が日付の形でない', (d) => { d.attachments[0].current.transactionDate = '10/26'; return d; }],
    ['書類の金額が負', (d) => { d.attachments[0].current.amountYen = -1; return d; }],
    ['書類の通貨が3文字の大文字でない', (d) => { d.attachments[0].current.currency = 'jpy'; return d; }],
    ['書類の voided が真偽値でない', (d) => { d.attachments[0].current.voided = 'no'; return d; }],
    ['書類の版の数が0', (d) => { d.attachments[0].revisionCount = 0; return d; }],
    ['保存途中の予約の expired が真偽値でない', (d) => { d.pendingUploads[0].expired = 'yes'; return d; }],
    ['保存途中の予約の期限が日付でない', (d) => { d.pendingUploads[0].expiresAt = 'いつか'; return d; }],
    ['flags が無い', (d) => { delete d.flags; return d; }],
    ['flags の値が真偽値でない', (d) => { d.flags.unitPriceMissing = 'true'; return d; }],
    ['見込額が負', (d) => { d.estimatedAmountYen = -1; return d; }],
    ['見込額が文字列', (d) => { d.estimatedAmountYen = '6000'; return d; }],
    ['見込額が小数', (d) => { d.estimatedAmountYen = 0.5; return d; }],
  ];

  test.each(BROKEN)('FREQ-526-AC-05: 形の崩れ（%s）は内部の失敗 PURCHASE_ORDER_READ_FAILED で、生の値を持たない', (_name, mutate) => {
    const input = mutate(clone());
    let caught: unknown;
    try { parsePurchaseOrderDetail(input); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe('PURCHASE_ORDER_READ_FAILED');
    expect(JSON.stringify(caught)).not.toContain('PRIVATE-MARKER');
  });

  test('FREQ-526-AC-05: 相殺の受取行（数量が負）は元の行を指し、取り消せる数は0', () => {
    const raw = clone();
    raw.receipts.push({
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2', kind: 'reverse', receivedOn: '2026-10-27', memo: null, reason: '数え間違い',
      actorId: raw.createdBy, createdAt: '2026-10-27T01:00:00+00:00',
      lines: [{ id: 'cccccccc-cccc-4ccc-8ccc-ccccccccccc2', lineId: raw.lines[0].id, quantity: -1, reversesReceiptLineId: raw.receipts[0].lines[0].id, reversibleQuantity: 0 }],
    });
    raw.receipts[0].lines[0].reversibleQuantity = 1;
    expect(parsePurchaseOrderDetail(raw).receipts[1].lines[0]).toMatchObject({ quantity: -1, reversibleQuantity: 0 });
  });

  test('FREQ-526-AC-04: parsePurchaseOrderListRow は数量確定前の行（発注数量・未納が NULL）と確定後の行を返し、崩れた行は内部の失敗にする', () => {
    expect(parsePurchaseOrderListRow(listRow())).toEqual(listRow());
    const unconfirmed = listRow({ displayStage: 'ordered', orderQuantity: null, receivedQuantity: 0, outstandingQuantity: null });
    expect(parsePurchaseOrderListRow(unconfirmed)).toEqual(unconfirmed);
    const broken: unknown[] = [
      null, 'x', { ...listRow(), purchaseOrderId: 'abc' }, { ...listRow(), number: 'x' }, { ...listRow(), displayStage: 'draft' },
      { ...listRow(), lineNo: 0 }, { ...listRow(), itemName: 1 }, { ...listRow(), provisionalQuantity: -1 },
      { ...listRow(), receivedQuantity: 2.5 }, { ...listRow(), orderQuantity: null }, { ...listRow(), outstandingQuantity: null },
      { ...listRow(), outstandingQuantity: 9 }, { ...listRow(), colorName: 5 },
    ];
    for (const row of broken) expect(() => parsePurchaseOrderListRow(row)).toThrow('PURCHASE_ORDER_READ_FAILED');
  });

  test('FREQ-526-AC-05: 発注日は日本時間の YYYY/MM/DD（協定世界時の15時以降は翌日）、日時は YYYY/MM/DD HH:mm', () => {
    expect(formatPurchaseOrderDate('2026-10-25T14:59:59+00:00')).toBe('2026/10/25');
    expect(formatPurchaseOrderDate('2026-10-25T15:00:00+00:00')).toBe('2026/10/26');
    expect(formatPurchaseOrderDate('2026-12-31T20:00:00Z')).toBe('2027/01/01');
    expect(formatPurchaseOrderDate('2026-10-25T23:30:00+09:00')).toBe('2026/10/25');
    expect(formatPurchaseOrderDateTime('2026-10-25T15:05:00+00:00')).toBe('2026/10/26 00:05');
    expect(formatPurchaseOrderDay('2026-10-26')).toBe('2026/10/26');
  });

  test.each([[0, '¥0'], [980, '¥980'], [1200, '¥1,200'], [6000, '¥6,000'], [1234567, '¥1,234,567'], [99999999999, '¥99,999,999,999']])(
    'FREQ-526-AC-05: 金額 %i は %s の形で出す', (amount, expected) => {
      expect(formatYen(amount)).toBe(expected);
    });

  test('FREQ-526-AC-05: 目印 created=1 を見るのは、created がちょうど "1" の時だけ（無い・別の値・複数は通知を出さない）', () => {
    const [key, value] = PURCHASE_ORDER_CREATED_QUERY.split('=');
    expect(isPurchaseOrderCreatedQuery({ [key]: value })).toBe(true);
    expect(isPurchaseOrderCreatedQuery({})).toBe(false);
    expect(isPurchaseOrderCreatedQuery({ created: '0' })).toBe(false);
    expect(isPurchaseOrderCreatedQuery({ created: '' })).toBe(false);
    expect(isPurchaseOrderCreatedQuery({ created: 'true' })).toBe(false);
    expect(isPurchaseOrderCreatedQuery({ created: ['1', '1'] })).toBe(false);
    expect(isPurchaseOrderCreatedQuery({ other: '1' })).toBe(false);
  });
});
