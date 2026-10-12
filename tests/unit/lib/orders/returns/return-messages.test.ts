import fs from 'node:fs';
import path from 'node:path';
import { toOrderNumber } from '@/lib/orders/order-number';
import { REFUND_ERROR_CODES } from '@/lib/orders/refund/refund-types';
import {
  DISPOSITION_LABELS,
  RETURN_CARRIER_LABELS,
  RETURN_DISPLAY_STATUS_LABELS,
  RETURN_ERROR_MESSAGES,
  RETURN_MARK_LABELS,
  RETURN_REASON_LABELS,
  formatReturnNumber,
} from '@/lib/orders/returns/return-messages';
import {
  RETURN_CARRIERS,
  RETURN_DISPLAY_STATUSES,
  RETURN_ERROR_CODES,
  RETURN_MARKS,
  RETURN_NEXT_ACTIONS,
  RETURN_REASONS,
  RETURN_STATUSES,
} from '@/lib/orders/returns/return-types';
import { SHIPPING_CARRIERS } from '@/lib/orders/shipping-carriers';

const ORDER_ID = 'a1b2c3d4-1111-4222-8333-444455556666';

/** 版の頭の数字は本番に当てる時に付け替わるので、移行のファイルは名前の後ろで探す */
function migrationText(suffix: string): string {
  const directory = path.join(process.cwd(), 'supabase/migrations');
  const files = fs.readdirSync(directory).filter((name) => name.endsWith(suffix));
  expect(files).toHaveLength(1);
  return fs.readFileSync(path.join(directory, files[0]), 'utf8');
}

// 共通の約束 C-4 の表。言葉を直す時は、画面と文書の言葉も一緒に直すため、ここは1字も変えずに写す
const EXPECTED = [
  ['RETURN_NOT_FOUND', 404, '返品が見つかりません。'],
  ['RETURN_ARGUMENT_INVALID', 400, '入力を確かめてください。'],
  ['RETURN_QUANTITY_EXCEEDS', 409, '返品できる数を超えています。画面を開き直してください。'],
  ['RETURN_EXCHANGE_VARIANT_INVALID', 400, '交換の色・サイズを選び直してください（同じ商品の色・サイズだけ選べます）。'],
  ['RETURN_ADDRESS_REQUIRED', 409, '返送先が設定されていません。ショップの設定で返送先を入れてから作ってください。'],
  ['RETURN_STATE_CONFLICT', 409, '返品の状態が変わりました。画面を開き直してください。'],
  ['RETURN_RECEIPT_EXCEEDS', 409, '受け取る数が、残りの数を超えています。画面を開き直してください。'],
  ['RETURN_EXCHANGE_OUT_OF_STOCK', 409, '交換の品の在庫が足りません。「作って送る」か「返金に変える」を選んでください。'],
  ['RETURN_FORBIDDEN', 403, 'この操作は店長だけができます。'],
  ['RETURN_REQUEST_MISMATCH', 409, '同じ操作の番号で、違う内容が送られました。画面を開き直してください。'],
  ['RETURN_REASON_NOTE_REQUIRED', 400, '理由が「その他」の時は、理由のメモを入れてください。'],
  ['RETURN_SENT_BACK_MESSAGE_REQUIRED', 400, 'お返しする時は、お客様へのメッセージを入れてください。'],
  ['RETURN_FEE_INVALID', 400, '手数料の額を確かめてください。'],
  ['RETURN_REFUND_AMOUNT_INVALID', 400, '返金額は、返せる額までにしてください。'],
  ['RETURN_NOTHING_TO_REFUND', 409, '返金する品がありません。画面を開き直してください。'],
  ['FULFILLMENT_HAS_RETURN', 409, '返品のある発送は取り消せません。'],
  ['FULFILLMENT_EXCHANGE_ON_HOLD', 409, '手数料のお支払いを待っている交換の品は送れません。'],
  ['ORDER_NOT_RETURNABLE', 409, 'この注文は返品を作れません。'],
] as const;

describe('返品の記号', () => {
  it('返品・返品の行・受け取りの記録の値は Global Constraints のとおり', () => {
    expect([...RETURN_STATUSES]).toEqual(['requested', 'open', 'closed', 'cancelled', 'declined']);
    expect([...RETURN_DISPLAY_STATUSES]).toEqual(['requested', 'in_progress', 'refund_waiting', 'returned']);
    expect([...RETURN_MARKS]).toEqual(['awaiting_items', 'partially_received', 'pending_inspection', 'awaiting_fee']);
    expect([...RETURN_NEXT_ACTIONS]).toEqual(['review_request', 'refund', 'receive', 'none']);
    expect([...RETURN_REASONS]).toEqual([
      'defective', 'wrong_item', 'size_too_small', 'size_too_large', 'color', 'style', 'not_as_described', 'unwanted', 'other', 'unknown',
    ]);
    expect([...RETURN_CARRIERS]).toEqual(['yamato', 'sagawa', 'japanpost', 'other']);
  });

  it('窓口が返す18の誤りの記号は共通の約束 C-2 のとおり', () => {
    expect([...RETURN_ERROR_CODES]).toEqual([
      'RETURN_NOT_FOUND', 'RETURN_ARGUMENT_INVALID', 'RETURN_QUANTITY_EXCEEDS', 'RETURN_EXCHANGE_VARIANT_INVALID',
      'RETURN_ADDRESS_REQUIRED', 'RETURN_STATE_CONFLICT', 'RETURN_RECEIPT_EXCEEDS', 'RETURN_EXCHANGE_OUT_OF_STOCK',
      'RETURN_FORBIDDEN', 'RETURN_REQUEST_MISMATCH', 'RETURN_REASON_NOTE_REQUIRED', 'RETURN_SENT_BACK_MESSAGE_REQUIRED',
      'RETURN_FEE_INVALID', 'RETURN_REFUND_AMOUNT_INVALID', 'RETURN_NOTHING_TO_REFUND', 'FULFILLMENT_HAS_RETURN',
      'FULFILLMENT_EXCHANGE_ON_HOLD', 'ORDER_NOT_RETURNABLE',
    ]);
  });

  it('状態・理由・配送業者の値は、移行 A の CHECK の値と同じ（綴りが食い違うと、DB が断る）', () => {
    const sql = migrationText('_order_return_records.sql');

    for (const value of [...RETURN_STATUSES, ...RETURN_REASONS, ...RETURN_CARRIERS]) {
      expect(sql).toContain(`'${value}'`);
    }
  });
});

describe('誤りの記号ごとの HTTP と言葉', () => {
  it.each(EXPECTED)('%s は %i、言葉は「%s」', (code, status, message) => {
    expect(RETURN_ERROR_MESSAGES[code]).toEqual({ status, message });
  });

  it('表は誤りの記号を過不足なく持つ（記号を足したら言葉と HTTP も要る）', () => {
    const codes = [...RETURN_ERROR_CODES].sort();

    expect(EXPECTED.map(([code]) => code).sort()).toEqual(codes);
    expect(Object.keys(RETURN_ERROR_MESSAGES).sort()).toEqual(codes);
  });

  it('返品の記号と E-2 の記号は重ならない（ReturnStoreError.code は両方を持つので、どちらの表を引くかを記号だけで決められる）', () => {
    const refundCodes = new Set<string>(REFUND_ERROR_CODES);

    for (const code of RETURN_ERROR_CODES) {
      expect(refundCodes.has(code)).toBe(false);
    }
  });
});

describe('ラベルの表（共通の約束 C-5）', () => {
  it('返品の状態の言葉（返品の無い注文の — は、状態が無い（null）時に画面が出す）', () => {
    expect(RETURN_DISPLAY_STATUS_LABELS).toEqual({
      requested: '返品の申し込み', in_progress: '返品中', refund_waiting: '返金待ち', returned: '返品済み',
    });
    expect(Object.keys(RETURN_DISPLAY_STATUS_LABELS)).toEqual([...RETURN_DISPLAY_STATUSES]);
  });

  it('返品中の小さな印の言葉', () => {
    expect(RETURN_MARK_LABELS).toEqual({
      awaiting_items: '受け取り待ち', partially_received: '一部受け取り', pending_inspection: '検品待ち', awaiting_fee: 'お支払い待ち',
    });
    expect(Object.keys(RETURN_MARK_LABELS)).toEqual([...RETURN_MARKS]);
  });

  it('理由の言葉（10の理由が全部ある）', () => {
    expect(RETURN_REASON_LABELS).toEqual({
      defective: '破損・不良',
      wrong_item: '注文と違う品が届いた',
      size_too_small: 'サイズが小さい',
      size_too_large: 'サイズが大きい',
      color: '色がイメージと違った',
      style: 'デザインが好みでない',
      not_as_described: '説明と違った',
      unwanted: '不要になった',
      other: 'その他',
      unknown: '不明',
    });
    expect(Object.keys(RETURN_REASON_LABELS)).toEqual([...RETURN_REASONS]);
  });

  it('配送業者の言葉。3社は発送の配送業者の表（shipping-carriers.ts）と同じ', () => {
    expect(RETURN_CARRIER_LABELS).toEqual({ yamato: 'ヤマト運輸', sagawa: '佐川急便', japanpost: '日本郵便', other: 'その他' });
    expect(Object.keys(RETURN_CARRIER_LABELS)).toEqual([...RETURN_CARRIERS]);
    for (const carrier of ['yamato', 'sagawa', 'japanpost'] as const) {
      expect(RETURN_CARRIER_LABELS[carrier]).toBe(SHIPPING_CARRIERS[carrier].label);
    }
  });

  it('受け取りの品の状態の言葉', () => {
    expect(DISPOSITION_LABELS).toEqual({
      restocked: '在庫に戻す',
      not_restocked: '戻さない',
      pending_inspection: '検品待ち',
      sent_back: '条件に合わないのでお返しする',
    });
  });
});

describe('formatReturnNumber（注文番号-R{n}）', () => {
  it.each([
    [1, 'ORD-A1B2C3D4-R1'],
    [2, 'ORD-A1B2C3D4-R2'],
    [12, 'ORD-A1B2C3D4-R12'],
  ])('%i 番目の返品は %s', (number, expected) => {
    expect(formatReturnNumber(ORDER_ID, number)).toBe(expected);
  });

  it('注文番号は今の toOrderNumber と同じ（画面・メール・履歴で注文番号の書き方が食い違わない）', () => {
    expect(formatReturnNumber(ORDER_ID, 3)).toBe(`${toOrderNumber(ORDER_ID)}-R3`);
  });
});

describe('画面からも読めること', () => {
  const SCREEN_FILES: Array<[file: string, imports: string[], valueImports: string[]]> = [
    ['src/lib/orders/returns/return-types.ts', ['@/lib/orders/order-payment-types', '@/lib/orders/refund/refund-types'], []],
    [
      'src/lib/orders/returns/return-messages.ts',
      ['@/lib/orders/order-number', '@/lib/orders/returns/return-types'],
      // 値を読む import は、画面からも読める注文番号の書き方だけ（サーバーだけの物を import しない）
      ['@/lib/orders/order-number'],
    ],
  ];

  it.each(SCREEN_FILES)('%s はサーバーだけの物を import しない', (file, expected, expectedValueImports) => {
    const source = fs.readFileSync(path.join(process.cwd(), file), 'utf8');
    const specifiers = [...source.matchAll(/from '([^']+)'/g)].map((match) => match[1]);
    const valueImports = [...source.matchAll(/^import (?!type\b)[^;]*?from '([^']+)'/gm)].map((match) => match[1]);

    expect([...specifiers].sort()).toEqual([...expected].sort());
    expect([...valueImports].sort()).toEqual([...expectedValueImports].sort());
  });
});
