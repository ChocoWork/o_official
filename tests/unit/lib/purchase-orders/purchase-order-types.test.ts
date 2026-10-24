import {
  PURCHASE_ORDER_ACTION_TEXT,
  PURCHASE_ORDER_ATTACHMENT_KIND_LABELS,
  PURCHASE_ORDER_CREATED_QUERY,
  PURCHASE_ORDER_DETAIL_TEXT,
  PURCHASE_ORDER_DISPLAY_STAGE_LABELS,
  PURCHASE_ORDER_DOCUMENT_ERRORS,
  PURCHASE_ORDER_DOCUMENT_MAX_BYTES,
  PURCHASE_ORDER_DOCUMENT_MIN_DAY,
  PURCHASE_ORDER_DOCUMENT_PAGE_LIMIT,
  PURCHASE_ORDER_DOCUMENT_SIGNATURE_LENGTH,
  PURCHASE_ORDER_DOCUMENT_TEXT,
  PURCHASE_ORDER_ERRORS,
  PURCHASE_ORDER_LIMITS,
  PURCHASE_ORDER_LIST_TEXT,
  PURCHASE_ORDER_READ_FAILED,
  PURCHASE_ORDER_TEXT,
  PURCHASE_ORDER_VERSION_CONFLICT_CODE,
  formatPurchaseOrderCreatedNotice,
  formatPurchaseOrderDate,
  formatPurchaseOrderDateTime,
  formatPurchaseOrderDay,
  formatPurchaseOrderReleaseConfirmation,
  formatYen,
  isPurchaseOrderCreatedQuery,
  isPurchaseOrderDay,
  hasPurchaseOrderDocumentSignature,
  isPurchaseOrderErrorCode,
  isPurchaseOrderQuantity,
  parsePurchaseOrderDetail,
  parsePurchaseOrderDocumentSearchRow,
  parsePurchaseOrderListRow,
  purchaseOrderDocumentMimeOfName,
  purchaseOrderDocumentStateLabel,
  PURCHASE_ORDER_RECEIPT_TEXT,
  PURCHASE_ORDER_SURFACE_FORBIDDEN,
  purchaseOrderCreateFailureMessage,
  purchaseOrderErrorBody,
  purchaseOrderFailureMessage,
  purchaseOrderJstDay,
  readReleasedQuantity,
  type PurchaseOrderDisplayStage,
  type PurchaseOrderStage,
} from '@/lib/purchase-orders/purchase-order-types';
import { ATTACHMENT_ID, confirmedDetail, listRow, ORDER_ID, orderedDetail } from './purchase-order-fixtures';

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

describe('purchase-order-types: 数量の確定・訂正・打切り・発注先の訂正（Task 6）', () => {
  test('FREQ-527-AC-01: DB エラー表に Task 6 の5つがあり、SQLSTATE・状態・本文は計画のとおり', () => {
    expect(PURCHASE_ORDER_ERRORS.GROUP_G_PO_NOT_FOUND).toEqual(['P0002', 404, '発注書が見つかりません。']);
    expect(PURCHASE_ORDER_ERRORS.GROUP_G_PO_VERSION_CONFLICT).toEqual(['55000', 409, '発注書が更新されました。内容を確認して、もう一度送ってください。']);
    expect(PURCHASE_ORDER_ERRORS.GROUP_G_PO_REASON_REQUIRED).toEqual(['22023', 400, '理由を入力してください。']);
    expect(PURCHASE_ORDER_ERRORS.GROUP_G_PO_QUANTITY_BELOW_RECEIVED).toEqual(['23514', 409, '納品済みの数より少ない数量には訂正できません。']);
    expect(PURCHASE_ORDER_ERRORS.GROUP_G_PO_NOTHING_TO_CLOSE).toEqual(['55000', 409, '打ち切る未納がありません。']);
    expect(PURCHASE_ORDER_VERSION_CONFLICT_CODE).toBe('GROUP_G_PO_VERSION_CONFLICT');
  });

  test('FREQ-527-AC-01: 操作のボタンの名前と成功の通知は計画のとおり', () => {
    expect(PURCHASE_ORDER_ACTION_TEXT).toEqual({
      confirmQuantities: '数量確定',
      cancelOrder: '発注を取り消す',
      correctQuantities: '数量を訂正',
      correctHeader: '発注先・メモを訂正',
      shortClose: '残りを打ち切る',
      selectOutstanding: '未納のある行をすべて選ぶ',
      quantitiesConfirmedNotice: '数量を確定しました。',
      quantitiesCorrectedNotice: '数量を訂正しました。',
      shortClosedNotice: '残りを打ち切りました。',
      headerCorrectedNotice: '発注先・メモを訂正しました。',
      cancelledNotice: '発注を取り消しました。',
    });
  });

  test('FREQ-527-AC-01: 失敗の文は 作成と同じ関数で、Task 6 の code（版の競合・理由・納品済み未満・打切りなし）は表の本文を出す', () => {
    expect(purchaseOrderCreateFailureMessage).toBe(purchaseOrderFailureMessage);
    expect(purchaseOrderFailureMessage(409, { code: 'GROUP_G_PO_VERSION_CONFLICT', error: 'x' })).toBe('発注書が更新されました。内容を確認して、もう一度送ってください。');
    expect(purchaseOrderFailureMessage(400, { code: 'GROUP_G_PO_REASON_REQUIRED' })).toBe('理由を入力してください。');
    expect(purchaseOrderFailureMessage(409, { code: 'GROUP_G_PO_QUANTITY_BELOW_RECEIVED' })).toBe('納品済みの数より少ない数量には訂正できません。');
    expect(purchaseOrderFailureMessage(409, { code: 'GROUP_G_PO_NOTHING_TO_CLOSE' })).toBe('打ち切る未納がありません。');
    expect(purchaseOrderFailureMessage(404, { code: 'GROUP_G_PO_NOT_FOUND' })).toBe('発注書が見つかりません。');
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
    ['受取の実行者のメールアドレスが無い(項目ごと欠けている)', (d) => { delete d.receipts[0].actorEmail; return d; }],
    ['受取の実行者のメールアドレスが文字でない', (d) => { d.receipts[0].actorEmail = 1; return d; }],
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
    ['保存途中の予約の差し替え元が uuid でない', (d) => { d.pendingUploads[0].replacesAttachmentId = 'x'; return d; }],
    ['保存途中の予約の差し替え元の項目が無い', (d) => { delete d.pendingUploads[0].replacesAttachmentId; return d; }],
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

  test('FREQ-529-AC-01: 受取の実行者のメールアドレスは文字か null(アカウントが無い)で、そのまま返す', () => {
    const raw = clone();
    expect(parsePurchaseOrderDetail(raw).receipts[0].actorEmail).toBe('staff@example.com');
    raw.receipts[0].actorEmail = null;
    expect(parsePurchaseOrderDetail(raw).receipts[0].actorEmail).toBeNull();
  });

  test('FREQ-526-AC-05: 相殺の受取行（数量が負）は元の行を指し、取り消せる数は0', () => {
    const raw = clone();
    raw.receipts.push({
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2', kind: 'reverse', receivedOn: '2026-10-27', memo: null, reason: '数え間違い',
      actorId: raw.createdBy, actorEmail: null, createdAt: '2026-10-27T01:00:00+00:00',
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

describe('purchase-order-types: 受け取りとその取消・数量訂正（Task 7）', () => {
  test('FREQ-529-AC-01: DB エラー表に Task 7 の6つがあり、SQLSTATE・状態・本文は計画のとおり', () => {
    expect(PURCHASE_ORDER_ERRORS.GROUP_G_PO_NOT_CONFIRMED).toEqual(['55000', 409, '数量が確定するまで受け取りはできません。']);
    expect(PURCHASE_ORDER_ERRORS.GROUP_G_PO_RECEIVE_EXCEEDS_REMAINING).toEqual(['23514', 409, '未納の数を超えて受け取ることはできません。先に数量を訂正してください。']);
    expect(PURCHASE_ORDER_ERRORS.GROUP_G_PO_RECEIVED_ON_INVALID).toEqual(['22023', 400, '受取日は発注日から今日までの日付にしてください。']);
    expect(PURCHASE_ORDER_ERRORS.GROUP_G_PO_REVERSE_EXCEEDS_RECEIVED).toEqual(['23514', 409, '取り消せる数を超えています。']);
    expect(PURCHASE_ORDER_ERRORS.GROUP_G_PO_REVERSE_STOCK_INSUFFICIENT)
      .toEqual(['23514', 409, '在庫が足りないため取り消せません。取り消す数が、空き在庫と外せる割当の合計を超えています。']);
    expect(PURCHASE_ORDER_ERRORS.GROUP_G_STOCK_RELEASE_CONFIRMATION_REQUIRED).toEqual(['55000', 409, '割り当て済みの品を外す必要があります。数量を確認してください。']);
  });

  test('FREQ-529-AC-01: 受け取りの固定の文は計画のとおり', () => {
    expect(PURCHASE_ORDER_RECEIPT_TEXT).toEqual({
      receiveAll: '全部受け取る',
      receivePart: '一部を受け取る',
      receiveAllTitle: '全部を受け取る',
      receivePartTitle: '一部を受け取る',
      receiveNote: '検品で不良だった分は入力せず、未納のまま待つか、あとで打ち切ってください。',
      receiveSubmit: '受け取りを確定',
      receivedNotice: '受け取りを記録しました。',
      reverse: 'この受け取りを取り消す',
      correct: '数量を訂正',
      reverseTitle: '受け取りの取消',
      correctTitle: '受け取り数量の訂正',
      reverseNote: '受け取りで入った在庫を、まず空き在庫から減らします。足りない時は、支払い済みの注文の割当を新しい注文から外します。',
      reverseSubmit: '取り消す',
      correctSubmit: '訂正する',
      reversedNotice: '受け取りを取り消しました。',
      correctedNotice: '受け取り数量を訂正しました。',
      reasonRequired: '理由を入力してください。',
    });
    expect(formatPurchaseOrderReleaseConfirmation(3)).toBe('割り当て済みの品を3点外し、受注生産中に戻します。');
  });

  test('FREQ-529-AC-01: 権限の文は画面ごとに替わる。発注は「発注を扱う権限がありません。」、受け取りは「受け取りを記録する権限がありません。」', () => {
    expect(PURCHASE_ORDER_SURFACE_FORBIDDEN).toEqual({ order: '発注を扱う権限がありません。', receipt: '受け取りを記録する権限がありません。' });
    expect(purchaseOrderErrorBody('GROUP_G_FORBIDDEN')).toBe('発注を扱う権限がありません。');
    expect(purchaseOrderErrorBody('GROUP_G_FORBIDDEN', 'order')).toBe('発注を扱う権限がありません。');
    expect(purchaseOrderErrorBody('GROUP_G_FORBIDDEN', 'receipt')).toBe('受け取りを記録する権限がありません。');
    // 権限以外の誤りは画面によらず同じ本文
    expect(purchaseOrderErrorBody('GROUP_G_PO_NOT_CONFIRMED', 'receipt')).toBe(PURCHASE_ORDER_ERRORS.GROUP_G_PO_NOT_CONFIRMED[2]);
    expect(purchaseOrderErrorBody('GROUP_G_PO_NOT_CONFIRMED', 'order')).toBe(PURCHASE_ORDER_ERRORS.GROUP_G_PO_NOT_CONFIRMED[2]);
  });

  test('FREQ-529-AC-01: 失敗の文（受け取り）: 表の code の本文 → CSRF → MFA → 401 → 403 は受け取り用の権限の文 → 400 → その他', () => {
    const failure = (status: number, body: unknown) => purchaseOrderFailureMessage(status, body, 'receipt');
    expect(failure(403, { code: 'GROUP_G_FORBIDDEN', error: 'x' })).toBe('受け取りを記録する権限がありません。');
    expect(failure(403, { error: 'Forbidden', permission: 'admin.receiving.manage', role: 'supporter' })).toBe('受け取りを記録する権限がありません。');
    expect(failure(403, { error: 'Forbidden', reason: 'MFA required' })).toBe('2要素認証が必要です');
    expect(failure(401, { error: 'Unauthorized' })).toBe('ログインし直してください。');
    expect(failure(400, { error: 'Invalid request', details: {} })).toBe('入力を確かめてください。');
    expect(failure(409, { code: 'GROUP_G_PO_RECEIVE_EXCEEDS_REMAINING' })).toBe('未納の数を超えて受け取ることはできません。先に数量を訂正してください。');
    expect(failure(409, { code: 'GROUP_G_PO_REVERSE_STOCK_INSUFFICIENT' }))
      .toBe('在庫が足りないため取り消せません。取り消す数が、空き在庫と外せる割当の合計を超えています。');
    expect(failure(500, null)).toBe('発注の記録に失敗しました');
    expect(failure(500, { code: 'PRIVATE-MARKER', error: 'PRIVATE-MARKER' })).toBe('発注の記録に失敗しました');
    // 発注の画面は従来どおり(既定)
    expect(purchaseOrderFailureMessage(403, { error: 'Forbidden', permission: 'admin.purchase_orders.manage' })).toBe('発注を扱う権限がありません。');
  });

  test.each(['order', 'receipt'] as const)('FREQ-540-AC-07: CSRF の確かめで断られた403(%s)は「権限がありません」ではなく「再読み込みして、もう一度」の文', (surface) => {
    const message = purchaseOrderFailureMessage(403, { error: 'Forbidden', reason: 'CSRF validation failed' }, surface);
    expect(message).toBe('セキュリティ確認に失敗しました。ページを再読み込みして、もう一度送ってください。');
    expect(message).toBe(PURCHASE_ORDER_TEXT.csrfFailed);
    expect(message).not.toContain('権限');
    // 403 以外の同じ reason は CSRF の文にしない。MFA の知らせが無いただの 403 は権限の文のまま
    expect(purchaseOrderFailureMessage(500, { reason: 'CSRF validation failed' }, surface)).toBe('発注の記録に失敗しました');
    expect(purchaseOrderFailureMessage(403, { error: 'Forbidden' }, surface)).toBe(PURCHASE_ORDER_SURFACE_FORBIDDEN[surface]);
  });

  test.each([
    [{ code: 'GROUP_G_STOCK_RELEASE_CONFIRMATION_REQUIRED', releasedQuantity: 3 }, 3],
    [{ code: 'GROUP_G_STOCK_RELEASE_CONFIRMATION_REQUIRED', releasedQuantity: 0 }, 0],
    [{ code: 'GROUP_G_STOCK_RELEASE_CONFIRMATION_REQUIRED', releasedQuantity: 2147483647 }, 2147483647],
    [{ code: 'GROUP_G_STOCK_RELEASE_CONFIRMATION_REQUIRED', releasedQuantity: -1 }, null],
    [{ code: 'GROUP_G_STOCK_RELEASE_CONFIRMATION_REQUIRED', releasedQuantity: 1.5 }, null],
    [{ code: 'GROUP_G_STOCK_RELEASE_CONFIRMATION_REQUIRED', releasedQuantity: '3' }, null],
    [{ code: 'GROUP_G_STOCK_RELEASE_CONFIRMATION_REQUIRED', releasedQuantity: 2147483648 }, null],
    [{ code: 'GROUP_G_STOCK_RELEASE_CONFIRMATION_REQUIRED' }, null],
    [{ code: 'GROUP_G_PO_VERSION_CONFLICT', releasedQuantity: 3 }, null],
    [{ releasedQuantity: 3 }, null],
    [null, null], ['text', null], [[3], null],
  ])('FREQ-529-AC-04: 409 の本文 %j から外す点数を取り出す: %s', (body, expected) => {
    expect(readReleasedQuantity(body)).toBe(expected);
  });

  test('FREQ-529-AC-01: 日本時間の日付: 時刻を日本時間（+9時間）で日にする。日付の形と実在を確かめる', () => {
    expect(purchaseOrderJstDay(new Date('2026-10-25T14:59:59Z'))).toBe('2026-10-25');
    expect(purchaseOrderJstDay(new Date('2026-10-25T15:00:00Z'))).toBe('2026-10-26');
    expect(purchaseOrderJstDay('2026-10-25T14:30:00+00:00')).toBe('2026-10-25');
    expect(purchaseOrderJstDay('2026-10-25T15:30:00+00:00')).toBe('2026-10-26');
    expect(purchaseOrderJstDay('not a date')).toBe('');
    expect(purchaseOrderJstDay()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(isPurchaseOrderDay('2026-10-26')).toBe(true);
    expect(isPurchaseOrderDay('2028-02-29')).toBe(true);
    for (const value of ['2026-02-30', '2027-02-29', '2026-13-01', '2026-00-10', '2026/10/26', '2026-10-26T00:00:00Z', '26-10-26', '', ' 2026-10-26']) {
      expect({ value, valid: isPurchaseOrderDay(value) }).toEqual({ value, valid: false });
    }
  });

  test('FREQ-529-AC-01: 受取数量・受取のメモの範囲は計画のとおり(1〜99999・0〜200)', () => {
    expect(PURCHASE_ORDER_LIMITS.receivedQuantity).toEqual({ min: 1, max: 99999 });
    expect(PURCHASE_ORDER_LIMITS.receiptMemo).toEqual({ min: 0, max: 200 });
  });
});

describe('purchase-order-types: 取引書類の原本（Task 8）', () => {
  const documentRow = () => ({
    attachmentId: ATTACHMENT_ID, purchaseOrderId: ORDER_ID, purchaseOrderNumber: 'PO-20261025-0001', kind: 'invoice', fileName: 'invoice.pdf',
    mimeType: 'application/pdf', sizeBytes: 2048, revisionNo: 1, isCurrent: true, transactionDate: '2026-10-26', amountYen: 6000, currency: 'JPY',
    counterparty: '工場A', voided: false, reason: null, replacesAttachmentId: null, createdAt: '2026-10-26T03:00:00+00:00',
  });

  test('FREQ-530-AC-02: 原本の値の範囲は 取引先1〜100・ファイル名1〜255・金額0〜99999999999・20 MiB・取引日は 2000-01-01 以降・検索は50件/頁', () => {
    expect(PURCHASE_ORDER_LIMITS.counterparty).toEqual({ min: 1, max: 100 });
    expect(PURCHASE_ORDER_LIMITS.documentFileName).toEqual({ min: 1, max: 255 });
    expect(PURCHASE_ORDER_LIMITS.documentAmountYen).toEqual({ min: 0, max: 99999999999 });
    expect(PURCHASE_ORDER_DOCUMENT_MAX_BYTES).toBe(20 * 1024 * 1024);
    expect(PURCHASE_ORDER_DOCUMENT_MIN_DAY).toBe('2000-01-01');
    expect(PURCHASE_ORDER_DOCUMENT_PAGE_LIMIT).toBe(50);
  });

  test('FREQ-530-AC-02: DB の誤りの表に原本の3つがあり、SQLSTATE・状態・本文は計画のとおり', () => {
    expect(PURCHASE_ORDER_ERRORS.GROUP_G_PO_DOCUMENT_RESERVATION_INVALID).toEqual(['55000', 409, '保存の予約が見つかりません。もう一度ファイルを選んでください。']);
    expect(PURCHASE_ORDER_ERRORS.GROUP_G_PO_DOCUMENT_ALREADY_ATTACHED).toEqual(['55000', 409, 'この書類はすでに登録されています。']);
    expect(PURCHASE_ORDER_ERRORS.GROUP_G_PO_DOCUMENT_REPLACEMENT_INVALID).toEqual(['22023', 400, '差し替え元の書類を確かめてください。']);
  });

  test('FREQ-530-AC-02: 置き場の確かめの誤りの表は 状態と本文が計画のとおりで、本文は空でなく重複もなく、DB の表と code が重ならない', () => {
    expect(PURCHASE_ORDER_DOCUMENT_ERRORS).toEqual({
      DOCUMENT_NOT_UPLOADED: [409, 'ファイルがまだ届いていません。もう一度アップロードしてください。'],
      DOCUMENT_TYPE_UNSUPPORTED: [422, 'PDF・JPEG・PNG のファイルを選んでください。'],
      DOCUMENT_TOO_LARGE: [422, 'ファイルは 20 MiB までです。'],
      DOCUMENT_HASH_MISMATCH: [422, 'アップロードしたファイルの内容が一致しません。もう一度アップロードしてください。'],
      DOCUMENT_STORAGE_UNAVAILABLE: [503, 'ファイルの保存先に接続できません。時間をおいて再度お試しください。'],
      DOCUMENT_NOT_FOUND: [404, '原本を取得できません。'],
    });
    const bodies = [...Object.values(PURCHASE_ORDER_DOCUMENT_ERRORS).map(([, body]) => body), ...Object.values(PURCHASE_ORDER_ERRORS).map(([, , body]) => body)];
    expect(new Set(bodies).size).toBe(bodies.length);
    for (const code of Object.keys(PURCHASE_ORDER_DOCUMENT_ERRORS)) expect(Object.hasOwn(PURCHASE_ORDER_ERRORS, code)).toBe(false);
  });

  test('FREQ-530-AC-02: 誤り code の判定と本文は DB の表と原本の表の両方を引く。継承した名前・未知の code は表に無い', () => {
    expect(isPurchaseOrderErrorCode('GROUP_G_FORBIDDEN')).toBe(true);
    expect(isPurchaseOrderErrorCode('DOCUMENT_TOO_LARGE')).toBe(true);
    for (const code of ['', 'toString', '__proto__', 'constructor', 'PRIVATE-MARKER']) expect(isPurchaseOrderErrorCode(code)).toBe(false);
    expect(purchaseOrderErrorBody('DOCUMENT_NOT_FOUND')).toBe('原本を取得できません。');
    expect(purchaseOrderErrorBody('DOCUMENT_NOT_FOUND', 'receipt')).toBe('原本を取得できません。');
    expect(purchaseOrderErrorBody('GROUP_G_PO_DOCUMENT_ALREADY_ATTACHED')).toBe('この書類はすでに登録されています。');
  });

  test('FREQ-530-AC-02: 失敗の文は原本の code（DB の表・置き場の確かめ）も本文にする。表に無い code は出さない', () => {
    expect(purchaseOrderFailureMessage(409, { code: 'GROUP_G_PO_DOCUMENT_ALREADY_ATTACHED', error: 'x' })).toBe('この書類はすでに登録されています。');
    expect(purchaseOrderFailureMessage(422, { code: 'DOCUMENT_HASH_MISMATCH', error: 'x' })).toBe('アップロードしたファイルの内容が一致しません。もう一度アップロードしてください。');
    expect(purchaseOrderFailureMessage(503, { code: 'DOCUMENT_STORAGE_UNAVAILABLE', error: 'x' })).toBe('ファイルの保存先に接続できません。時間をおいて再度お試しください。');
    expect(purchaseOrderFailureMessage(422, { code: 'PRIVATE-MARKER', error: 'PRIVATE-MARKER' })).toBe('発注の記録に失敗しました');
  });

  test('FREQ-530-AC-02: 画面の固定の文は計画のとおり（取引書類の節・保存が終わっていないファイル・書類検索）', () => {
    expect(PURCHASE_ORDER_DOCUMENT_TEXT).toMatchObject({
      heading: '取引書類', add: '書類を追加', voidedBadge: '無効', view: '表示', download: 'ダウンロード', print: '印刷', correct: '情報を訂正',
      replace: '差し替える', void: '無効にする', pendingHeading: '保存が終わっていないファイル', resume: '続きから保存',
      expired: '期限を過ぎています。内容を確認してください。',
      searchHeading: '取引書類の検索', searchDateFrom: '取引日（から）', searchDateTo: '取引日（まで）', searchAmountMin: '金額（円）（から）',
      searchAmountMax: '金額（円）（まで）', searchCounterparty: '取引先', searchNumber: '発注書番号', searchKind: '種類',
      searchIncludeHistory: '訂正前の情報も探す', search: '検索', clear: '条件をクリア', searchEmpty: '該当する書類はありません。',
      searchForbidden: '取引書類を見る権限がありません。',
      columnNumber: '発注書番号', columnKind: '種類', columnFileName: 'ファイル名', columnDate: '取引日', columnAmount: '金額（円）',
      columnCounterparty: '取引先', columnState: '状態',
    });
    expect(PURCHASE_ORDER_ATTACHMENT_KIND_LABELS).toEqual({ quote: '見積書', invoice: '請求書' });
  });

  test('FREQ-530-AC-02: 書類検索の1行を検査して決まった項目だけにする。崩れた行・知らない項目は PURCHASE_ORDER_READ_FAILED / 落とす', () => {
    expect(parsePurchaseOrderDocumentSearchRow({ ...documentRow(), storagePath: 'x/y' })).toEqual(documentRow());
    for (const broken of [
      { kind: 'memo' }, { attachmentId: 'x' }, { purchaseOrderNumber: 'PO-1' }, { revisionNo: 0 }, { isCurrent: 'yes' }, { transactionDate: '2026/10/26' },
      { amountYen: -1 }, { amountYen: 1.5 }, { currency: 'jpy' }, { voided: null }, { reason: 1 }, { replacesAttachmentId: 'x' }, { createdAt: 'never' },
      { fileName: null }, { sizeBytes: -1 },
    ]) {
      expect(() => parsePurchaseOrderDocumentSearchRow({ ...documentRow(), ...broken })).toThrow(PURCHASE_ORDER_READ_FAILED);
    }
    expect(() => parsePurchaseOrderDocumentSearchRow(null)).toThrow(PURCHASE_ORDER_READ_FAILED);
    expect(parsePurchaseOrderDocumentSearchRow({ ...documentRow(), reason: '誤り', replacesAttachmentId: ATTACHMENT_ID })).toMatchObject({ reason: '誤り', replacesAttachmentId: ATTACHMENT_ID });
  });

  test.each([
    ['quote.pdf', 'application/pdf'], ['a.PDF', 'application/pdf'], ['a.b.jpg', 'image/jpeg'], ['x.JPEG', 'image/jpeg'], ['scan.Png', 'image/png'],
    ['quote', null], ['quote.', null], ['quote.txt', null], ['quote.pdf.exe', null], ['.pdf2', null], ['toString', null], ['a.constructor', null], ['', null],
  ])('FREQ-530-AC-02: ファイル名 %j の拡張子から決まる種類は %s（継承した名前は拾わない）', (name, mime) => {
    expect(purchaseOrderDocumentMimeOfName(name)).toBe(mime);
  });

  test('FREQ-530-AC-02: 先頭のバイトの印は PDF `%PDF-`・JPEG `FF D8 FF`・PNG `89 50 4E 47 0D 0A 1A 0A` で、種類が違えば合わない・短すぎれば合わない', () => {
    expect(PURCHASE_ORDER_DOCUMENT_SIGNATURE_LENGTH).toBe(8);
    const pdf = [0x25, 0x50, 0x44, 0x46, 0x2d, 0x31];
    const jpeg = [0xff, 0xd8, 0xff, 0xe0];
    const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    expect(hasPurchaseOrderDocumentSignature(pdf, 'application/pdf')).toBe(true);
    expect(hasPurchaseOrderDocumentSignature(jpeg, 'image/jpeg')).toBe(true);
    expect(hasPurchaseOrderDocumentSignature(png, 'image/png')).toBe(true);
    expect(hasPurchaseOrderDocumentSignature(png, 'application/pdf')).toBe(false);
    expect(hasPurchaseOrderDocumentSignature(pdf, 'image/jpeg')).toBe(false);
    expect(hasPurchaseOrderDocumentSignature(jpeg, 'image/png')).toBe(false);
    expect(hasPurchaseOrderDocumentSignature(png.slice(0, 7), 'image/png')).toBe(false);
    expect(hasPurchaseOrderDocumentSignature([], 'application/pdf')).toBe(false);
  });

  test('FREQ-530-AC-02: 種類の検査に通らなかった時・選び直しの文は計画の外の文で、検索結果の見出しと訂正のボタンの名前も定義にある', () => {
    expect(PURCHASE_ORDER_DOCUMENT_TEXT.resumeTypeMismatch).toBe('予約したファイルと同じ種類のファイルを選んでください。');
    expect(PURCHASE_ORDER_DOCUMENT_TEXT.rejectedFile).toBe('このファイルは保存できませんでした。PDF・JPEG・PNG の正しいファイルを選び直して、新しく保存してください。');
    expect(PURCHASE_ORDER_DOCUMENT_TEXT.correctSubmit).toBe('訂正する');
    expect(PURCHASE_ORDER_DOCUMENT_TEXT.searchResults).toBe('検索結果');
  });

  test('FREQ-530-AC-02: 検索結果の状態の文字は 訂正前の版 →「訂正前」、最新で無効 →「無効」、それ以外 →「有効」', () => {
    expect(purchaseOrderDocumentStateLabel({ isCurrent: true, voided: false })).toBe('有効');
    expect(purchaseOrderDocumentStateLabel({ isCurrent: true, voided: true })).toBe('無効');
    expect(purchaseOrderDocumentStateLabel({ isCurrent: false, voided: false })).toBe('訂正前');
    expect(purchaseOrderDocumentStateLabel({ isCurrent: false, voided: true })).toBe('訂正前');
  });
});
