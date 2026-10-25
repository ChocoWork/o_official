import { LEGACY_FULFILLMENT_DISABLED_TEXT } from '@/lib/orders/fulfillment/legacy-fulfillment-disabled';
import {
  formatOpenSlipLabel,
  formatOtherSlipNotice,
  isShipmentSlipErrorCode,
  isShipmentSlipStage,
  PACKING_COLUMN_HEADINGS,
  PACKING_HOLD_LABELS,
  PACKING_HOLD_REASONS,
  parsePackingRow,
  parseShipmentSlipDetail,
  parseShipmentSlipLink,
  parseShipmentSlipListRow,
  readShipmentSlipQueryInteger,
  SHIPMENT_SLIP_ERRORS,
  SHIPMENT_SLIP_FAILED,
  SHIPMENT_SLIP_LIMITS,
  SHIPMENT_SLIP_READ_FAILED,
  SHIPMENT_SLIP_STAGE_LABELS,
  SHIPMENT_SLIP_STAGES,
  SHIPMENT_SLIP_TEXT,
} from '@/lib/orders/shipment-slips/shipment-slip-types';
import {
  confirmedDetail,
  draftDetail,
  FULFILLMENT_ID,
  ITEM_ID,
  packingRow,
  SLIP_ID,
  slipListRow,
} from './shipment-slip-fixtures';

describe('段階と阻害理由の文', () => {
  test('FREQ-531-AC-01: 段階は4つで、画面の状態の文字は 下書き・発送済み・取消済み・破棄済み', () => {
    expect([...SHIPMENT_SLIP_STAGES]).toEqual(['draft', 'confirmed', 'cancelled', 'discarded']);
    expect(SHIPMENT_SLIP_STAGE_LABELS).toEqual({ draft: '下書き', confirmed: '発送済み', cancelled: '取消済み', discarded: '破棄済み' });
    expect(isShipmentSlipStage('confirmed')).toBe(true);
    expect(['', 'CONFIRMED', 'toString', null, 1].some((value) => isShipmentSlipStage(value))).toBe(false);
  });

  test('FREQ-531-AC-02: 阻害理由は5つで、荷作り表・票に出す文は共通の値のとおり', () => {
    expect([...PACKING_HOLD_REASONS]).toEqual(['payment_review', 'exchange_fee_waiting', 'variant_missing', 'address_incomplete', 'paid_at_missing']);
    expect(PACKING_HOLD_LABELS).toEqual({
      payment_review: '支払額の確認が済むまで選べません',
      exchange_fee_waiting: '交換手数料のお支払いを待っているため選べません',
      variant_missing: '色・サイズが確定していないため選べません',
      address_incomplete: '配送先の情報が足りないため選べません',
      paid_at_missing: '入金日時が記録されていないため選べません',
    });
  });

  test('FREQ-531-AC-01: 値の範囲は 行1〜100・数量1〜99999・下書き7日・荷作り表50件/頁・票の一覧20件/頁', () => {
    expect(SHIPMENT_SLIP_LIMITS).toEqual({
      lines: { min: 1, max: 100 },
      quantity: { min: 1, max: 99999 },
      draftExpiryDays: 7,
      packingPage: { limit: { min: 1, max: 100, fallback: 50 }, page: { min: 1, max: 100000, fallback: 1 } },
      slipPage: { limit: { min: 1, max: 100, fallback: 20 }, page: { min: 1, max: 100000, fallback: 1 } },
    });
  });
});

describe('DB のエラー表', () => {
  // 計画の「共通の値」のDBエラーの表。行を増やしたり本文を変えたら、ここと計画の両方を直す
  const EXPECTED: Array<[string, string, number, string]> = [
    ['GROUP_G_ARGUMENT_INVALID', '22023', 400, '入力を確かめてください。'],
    ['GROUP_G_FORBIDDEN', '42501', 403, '発送を扱う権限がありません。'],
    ['GROUP_G_REQUEST_KEY_CONFLICT', '23505', 409, '同じ要求番号で異なる操作は実行できません。'],
    ['GROUP_G_SLIP_NOT_FOUND', 'P0002', 404, '発送票が見つかりません。'],
    ['GROUP_G_SLIP_VERSION_CONFLICT', '55000', 409, '発送票が更新されました。内容を確認して、もう一度送ってください。'],
    ['GROUP_G_SLIP_NOT_DRAFT', '55000', 409, 'この発送票は下書きではありません。'],
    ['GROUP_G_SLIP_NOT_CONFIRMED', '55000', 409, '発送が確定した発送票だけで行える操作です。'],
    ['GROUP_G_SLIP_CANCELLED', '55000', 409, 'この発送票は取り消されています。'],
    ['GROUP_G_SLIP_DRAFT_EXPIRED', '55000', 409, '下書きの期限が切れました。品物を選び直してください。'],
    ['GROUP_G_SLIP_EMPTY', '22023', 400, '品物を選んでください。'],
    ['GROUP_G_SLIP_CUSTOMER_MISMATCH', '22023', 409, '同じお客様の注文だけを同梱できます。会員は同じ会員、ゲストは同じメールアドレスの注文に限ります。'],
    ['GROUP_G_SLIP_ADDRESS_MISMATCH', '22023', 409, '配送先がすべて同じ注文だけを同梱できます。'],
    ['GROUP_G_SLIP_ADDRESS_INCOMPLETE', '22023', 409, '配送先の情報が足りない注文は発送できません。'],
    ['GROUP_G_SLIP_ORDER_NOT_SHIPPABLE', '22023', 409, '入金が確認できていない注文は発送できません。'],
    ['GROUP_G_SLIP_PAYMENT_REVIEW_REQUIRED', '22023', 409, '支払額の確認が済むまで発送できません。'],
    ['GROUP_G_SLIP_EXCHANGE_ON_HOLD', '22023', 409, '交換手数料のお支払いを待っているため発送できません。'],
    ['GROUP_G_SLIP_QUANTITY_EXCEEDS_READY', '22023', 409, '発送準備中の数を超えています。荷作り表を読み直してください。'],
    ['GROUP_G_SLIP_TRACKING_INCOMPLETE', '22023', 400, '運送会社と伝票番号は、両方入れるか両方空にしてください。'],
    ['GROUP_G_SLIP_TRACKING_UNCHANGED', '22023', 409, '運送会社も伝票番号も変わっていません。'],
    ['GROUP_G_SHIPMENT_DATE_INVALID', '22023', 400, '出荷日は、入金日から今日までの日付にしてください。'],
    ['GROUP_G_SHIPMENT_DATE_AFTER_DELIVERY', '22023', 409, '配達済みの日より後の日にはできません。配送の記録を確かめてください。'],
    ['GROUP_G_SHIPMENT_DATE_UNCHANGED', '22023', 409, '出荷日が変わっていません。'],
    ['GROUP_G_SLIP_REASON_REQUIRED', '22023', 400, '理由を入力してください。'],
    ['GROUP_G_SLIP_ALREADY_DELIVERED', '55000', 409, 'この発送票はすでに配達済みです。'],
    ['GROUP_G_SLIP_DELIVERY_DATE_INVALID', '22023', 400, '届いた日は、発送した日から今日までの日付にしてください。'],
    ['GROUP_G_SLIP_HAS_RETURN', '22023', 409, '返品の対象になっている注文があるため、発送を取り消せません。'],
    ['GROUP_G_SLIP_REFUNDED', '22023', 409, '発送後に返金した注文があるため、発送を取り消せません。'],
    ['GROUP_G_SLIP_CANCEL_NOT_ALLOWED', '22023', 409, '取り消せない状態の注文があるため、発送を取り消せません。'],
  ];

  test('FREQ-531-AC-04: エラー表は共通の値の全28行を、SQLSTATE・HTTP の状態・本文まで完全一致で持つ', () => {
    expect(EXPECTED).toHaveLength(28);
    expect(Object.keys(SHIPMENT_SLIP_ERRORS)).toEqual(EXPECTED.map(([message]) => message));
    for (const [message, sqlstate, status, body] of EXPECTED) {
      expect({ message, row: SHIPMENT_SLIP_ERRORS[message] }).toEqual({ message, row: [sqlstate, status, body] });
    }
  });

  test('FREQ-531-AC-04: 本文に注文番号・氏名・住所を載せず、DB の内部のエラーは表に載せない', () => {
    for (const [, , body] of Object.values(SHIPMENT_SLIP_ERRORS)) {
      expect(body).not.toMatch(/ORD-|SL-|[0-9]{3}-[0-9]{4}/);
    }
    for (const internal of ['GROUP_G_SHIPMENT_CONSUMPTION', 'GROUP_G_INVENTORY_LOCK_REQUIRED', 'GROUP_G_SLIP_NUMBER_EXHAUSTED', 'GROUP_G_HISTORY_IMMUTABLE']) {
      expect(isShipmentSlipErrorCode(internal)).toBe(false);
    }
    expect(SHIPMENT_SLIP_FAILED).toBe('発送の記録に失敗しました');
  });

  test('FREQ-531-AC-04: 継承した名前は誤り code に数えない', () => {
    for (const inherited of ['toString', 'constructor', '__proto__', 'hasOwnProperty', '']) {
      expect(isShipmentSlipErrorCode(inherited)).toBe(false);
    }
    expect(isShipmentSlipErrorCode('GROUP_G_FORBIDDEN')).toBe(true);
  });
});

describe('画面の言葉', () => {
  test('FREQ-531-AC-01: 荷作り表の見出し・説明・列・通知は計画の「画面の言葉」と完全一致', () => {
    expect(SHIPMENT_SLIP_TEXT.packingHeading).toBe('荷作り表');
    expect(SHIPMENT_SLIP_TEXT.packingDescription).toBe('発送準備中の品物だけを表示します。品物を選んで「発送」を押すと、発送票の下書きを作ります。');
    expect([...PACKING_COLUMN_HEADINGS]).toEqual(['注文ID', '注文日', '顧客名', 'メールアドレス', '商品名', '色', 'サイズ', '数量', '単価']);
    expect(SHIPMENT_SLIP_TEXT.exchangeMark).toBe('交換の品');
    expect(SHIPMENT_SLIP_TEXT.packingEmpty).toBe('発送準備中の品物はありません。');
    expect(SHIPMENT_SLIP_TEXT.packingForbidden).toBe('荷作り表を見る権限がありません。');
    expect(SHIPMENT_SLIP_TEXT.packingFailed).toBe('荷作り表を読み込めませんでした。');
    expect(SHIPMENT_SLIP_TEXT.previousPage).toBe('前の頁');
    expect(SHIPMENT_SLIP_TEXT.nextPage).toBe('次の頁');
    expect(SHIPMENT_SLIP_TEXT.draftsHeading).toBe('発送票の下書き');
    expect(SHIPMENT_SLIP_TEXT.confirmedHeading).toBe('確定済みの発送票');
    expect(SHIPMENT_SLIP_TEXT.open).toBe('開く');
    expect(SHIPMENT_SLIP_TEXT.expired).toBe('期限切れ');
    expect(SHIPMENT_SLIP_TEXT.noTracking).toBe('伝票番号なし');
  });

  test('FREQ-531-AC-03: 別の下書きにも選ばれている行の通知は 別の発送票（番号）にも選ばれています', () => {
    expect(formatOtherSlipNotice(['SL-20261025-0002'])).toBe('別の発送票（SL-20261025-0002）にも選ばれています');
    expect(formatOtherSlipNotice(['SL-20261025-0002', 'SL-20261025-0003'])).toBe('別の発送票（SL-20261025-0002、SL-20261025-0003）にも選ばれています');
  });

  test('FREQ-524-AC-03: 旧い発送の操作の案内は、荷作り表の発送票へ向ける', () => {
    expect(LEGACY_FULFILLMENT_DISABLED_TEXT).toBe(
      '旧い発送の操作は終了しました。発送・発送取消・伝票番号の訂正・手動の配達済みは、荷作り表の発送票から行ってください。',
    );
    expect(SHIPMENT_SLIP_TEXT.orderSectionGuide).toBe('発送は荷作り表から行います。');
    expect(SHIPMENT_SLIP_TEXT.openPacking).toBe('荷作り表を開く');
    expect(SHIPMENT_SLIP_TEXT.orderHistoryGuide).toBe('発送・発送取消・伝票番号の訂正・手動の配達済みは、発送票から行います。');
    expect(formatOpenSlipLabel('SL-20261025-0001')).toBe('発送票 SL-20261025-0001 を開く');
  });
});

describe('readShipmentSlipQueryInteger', () => {
  const range = { min: 1, max: 100, fallback: 50 };

  test('FREQ-531-AC-01: 指定が無ければ既定値、あれば範囲内の10進の整数だけを数にする', () => {
    expect(readShipmentSlipQueryInteger(null, range)).toBe(50);
    expect(readShipmentSlipQueryInteger('1', range)).toBe(1);
    expect(readShipmentSlipQueryInteger('100', range)).toBe(100);
    expect(readShipmentSlipQueryInteger('0025', range)).toBe(25);
  });

  test.each(['', '0', '101', '-1', '+1', '1.5', '1e2', ' 1', '1 ', 'abc', '12345678', '０１'])(
    'FREQ-531-AC-01: %j は範囲外（null）', (value) => {
      expect(readShipmentSlipQueryInteger(value, range)).toBeNull();
    });
});

describe('parsePackingRow', () => {
  test('FREQ-531-AC-01: 正しい行を決まった項目だけで返し、知らない項目は落とす', () => {
    const row = packingRow({ blockedReasons: ['address_incomplete', 'paid_at_missing'], shippableQuantity: 0, otherSlipNumbers: ['SL-20261025-0002'] });
    expect(parsePackingRow({ ...row, extra: 'PRIVATE-MARKER' })).toEqual(row);
    expect(JSON.stringify(parsePackingRow({ ...row, extra: 'PRIVATE-MARKER' }))).not.toContain('PRIVATE-MARKER');
  });

  test('FREQ-531-AC-01: 名前・メール・色・サイズ・bundleKey・selectedQuantity は null でもよい', () => {
    const row = packingRow({ customerName: null, customerEmail: null, color: null, size: null, bundleKey: null, selectedQuantity: 2 });
    expect(parsePackingRow(row)).toEqual(row);
  });

  test.each([
    ['注文の番号が uuid でない', { orderId: 'x' }],
    ['明細の番号が無い', { orderItemId: undefined }],
    ['注文日が日時でない', { orderCreatedAt: 'いつか' }],
    ['商品名が文字でない', { itemName: 1 }],
    ['準備中の数が0', { readyQuantity: 0 }],
    ['準備中の数が小数', { readyQuantity: 1.5 }],
    ['発送できる数が負', { shippableQuantity: -1 }],
    ['単価が負', { unitPrice: -1 }],
    ['交換の印が真偽でない', { isExchange: 'false' }],
    ['阻害理由が知らない値', { blockedReasons: ['unknown'], shippableQuantity: 0 }],
    ['阻害理由が重なる', { blockedReasons: ['variant_missing', 'variant_missing'], shippableQuantity: 0 }],
    ['阻害理由が配列でない', { blockedReasons: 'variant_missing' }],
    ['理由が無いのに発送できる数が準備中の数と違う', { shippableQuantity: 1 }],
    ['理由があるのに発送できる数が0でない', { blockedReasons: ['variant_missing'] }],
    ['別の票の番号の形が違う', { otherSlipNumbers: ['SL-1'] }],
    ['選んだ数が負', { selectedQuantity: -1 }],
    ['同梱できるかが真偽でない', { bundleOk: null }],
    ['bundleKey が文字でない', { bundleKey: 1 }],
  ])('FREQ-531-AC-01: 崩れた行（%s）は SHIPMENT_SLIP_READ_FAILED で止める', (_name, patch) => {
    expect(() => parsePackingRow({ ...packingRow(), ...patch })).toThrow(SHIPMENT_SLIP_READ_FAILED);
  });

  test('FREQ-531-AC-01: オブジェクトでない行も止める', () => {
    for (const value of [null, undefined, 'x', 1, [], [packingRow()]]) {
      expect(() => parsePackingRow(value)).toThrow(SHIPMENT_SLIP_READ_FAILED);
    }
  });
});

describe('parseShipmentSlipListRow', () => {
  test('FREQ-531-AC-01: 正しい行を決まった項目だけで返す。下書きは出荷日・運送会社・伝票番号が null', () => {
    expect(parseShipmentSlipListRow({ ...slipListRow(), extra: 'PRIVATE-MARKER' })).toEqual(slipListRow());
    const draft = slipListRow({ stage: 'draft', shipmentDate: null, shippingCarrier: null, trackingNumber: null, expired: true });
    expect(parseShipmentSlipListRow(draft)).toEqual(draft);
  });

  test.each([
    ['番号の形が違う', { number: 'PO-20261025-0001' }],
    ['段階が知らない値', { stage: 'unknown' }],
    ['版が0', { version: 0 }],
    ['期限切れが真偽でない', { expired: 'no' }],
    ['出荷日の形が違う', { shipmentDate: '2026/10/25' }],
    ['運送会社が知らない値', { shippingCarrier: 'fedex' }],
    ['運送会社だけがあって伝票番号が無い', { trackingNumber: null }],
    ['伝票番号だけがあって運送会社が無い', { shippingCarrier: null }],
    ['注文数が負', { orderCount: -1 }],
    ['数量が小数', { itemQuantity: 1.5 }],
    ['更新日時が日時でない', { updatedAt: 'いつか' }],
  ])('FREQ-531-AC-01: 崩れた行（%s）は SHIPMENT_SLIP_READ_FAILED で止める', (_name, patch) => {
    expect(() => parseShipmentSlipListRow({ ...slipListRow(), ...patch })).toThrow(SHIPMENT_SLIP_READ_FAILED);
  });
});

describe('parseShipmentSlipDetail', () => {
  test('FREQ-531-AC-01: 下書きと確定済みの詳細を、決まった項目だけで返す', () => {
    expect(parseShipmentSlipDetail({ ...draftDetail(), storage: 'PRIVATE-MARKER' })).toEqual(draftDetail());
    expect(parseShipmentSlipDetail(confirmedDetail())).toEqual(confirmedDetail());
    expect(JSON.stringify(parseShipmentSlipDetail({ ...confirmedDetail(), storage: 'PRIVATE-MARKER' }))).not.toContain('PRIVATE-MARKER');
  });

  test('FREQ-531-AC-01: 追跡がオンで登録の無い票は state・everRegistered・leaderOrderId が null でもよい', () => {
    const detail = confirmedDetail({ registration: { enabled: true, state: null, everRegistered: null, leaderOrderId: null } });
    expect(parseShipmentSlipDetail(detail)).toEqual(detail);
  });

  test.each([
    ['票の番号が uuid でない', (d: Record<string, unknown>) => ({ ...d, id: 'x' })],
    ['票番号の形が違う', (d: Record<string, unknown>) => ({ ...d, number: 'SL-1' })],
    ['段階が知らない値', (d: Record<string, unknown>) => ({ ...d, stage: 'unknown' })],
    ['お客様の種類が知らない値', (d: Record<string, unknown>) => ({ ...d, customerKind: 'staff' })],
    ['送り先が無い', (d: Record<string, unknown>) => ({ ...d, shipTo: null })],
    ['送り先の氏名が文字でない', (d: Record<string, unknown>) => ({ ...d, shipTo: { ...(d.shipTo as object), fullName: 1 } })],
    ['運送会社だけがあって伝票番号が無い', (d: Record<string, unknown>) => ({ ...d, carrier: 'yamato', trackingNumber: null })],
    ['明細の送る数が0', (d: Record<string, unknown>) => ({ ...d, lines: [{ ...(d.lines as object[])[0], quantity: 0 }] })],
    ['明細が配列でない', (d: Record<string, unknown>) => ({ ...d, lines: null })],
    ['問題の種類が知らない値', (d: Record<string, unknown>) => ({ ...d, issues: [{ code: 'unknown', orderItemId: null }] })],
    ['期限切れが下書き以外にある', (d: Record<string, unknown>) => ({ ...d, stage: 'discarded', expired: true })],
    ['下書きなのに期限が無い', (d: Record<string, unknown>) => ({ ...d, expiresAt: null })],
    ['下書きでないのに期限がある', (d: Record<string, unknown>) => ({ ...d, stage: 'cancelled', expiresAt: '2026-11-01T03:00:00+00:00' })],
    ['追跡の登録の印が無い', (d: Record<string, unknown>) => ({ ...d, registration: undefined })],
    ['追跡がオフなのに登録の状態がある', (d: Record<string, unknown>) => ({ ...d, registration: { enabled: false, state: 'registered', everRegistered: null, leaderOrderId: null } })],
    ['追跡の状態が知らない値', (d: Record<string, unknown>) => ({ ...d, registration: { enabled: true, state: 'unknown', everRegistered: null, leaderOrderId: null } })],
  ])('FREQ-531-AC-01: 崩れた詳細（%s）は SHIPMENT_SLIP_READ_FAILED で止める', (_name, mutate) => {
    expect(() => parseShipmentSlipDetail(mutate({ ...draftDetail() }))).toThrow(SHIPMENT_SLIP_READ_FAILED);
  });

  test.each([
    ['取消を止める理由が知らない値', { cancelBlockers: [{ orderId: ITEM_ID, reason: 'unknown' }] }],
    ['注文ごとの発送の番号が0', { orders: [{ ...confirmedDetail().orders[0], fulfillmentNumber: 0 }] }],
    ['配送の状況が知らない値', { orders: [{ ...confirmedDetail().orders[0], deliveryStatus: 'lost' }] }],
    ['版の種類が知らない値', { versions: [{ ...confirmedDetail().versions[0], kind: 'unknown' }] }],
    ['版の運送会社が知らない値', { versions: [{ ...confirmedDetail().versions[0], carrier: 'fedex' }] }],
    ['出荷日の履歴の種類が知らない値', { dateHistory: [{ ...confirmedDetail().dateHistory[0], kind: 'unknown' }] }],
    ['出荷日の履歴の日付の形が違う', { dateHistory: [{ ...confirmedDetail().dateHistory[0], newDate: '10/25' }] }],
  ])('FREQ-531-AC-01: 崩れた確定済みの詳細（%s）も止める', (_name, patch) => {
    expect(() => parseShipmentSlipDetail({ ...confirmedDetail(), ...patch })).toThrow(SHIPMENT_SLIP_READ_FAILED);
  });
});

describe('parseShipmentSlipLink', () => {
  test('FREQ-533-AC-01: 発送が属する票を決まった項目だけで返す', () => {
    expect(parseShipmentSlipLink({ fulfillmentId: FULFILLMENT_ID, slipId: SLIP_ID, number: 'SL-20261025-0001', stage: 'confirmed', extra: 'x' }))
      .toEqual({ fulfillmentId: FULFILLMENT_ID, slipId: SLIP_ID, number: 'SL-20261025-0001', stage: 'confirmed' });
  });

  test.each([
    { fulfillmentId: 'x' }, { slipId: null }, { number: 'SL-1' }, { stage: 'unknown' },
  ])('FREQ-533-AC-01: 崩れた結び付き %j は止める', (patch) => {
    expect(() => parseShipmentSlipLink({ fulfillmentId: FULFILLMENT_ID, slipId: SLIP_ID, number: 'SL-20261025-0001', stage: 'confirmed', ...patch }))
      .toThrow(SHIPMENT_SLIP_READ_FAILED);
  });
});
