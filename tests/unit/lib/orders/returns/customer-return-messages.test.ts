import fs from 'node:fs';
import path from 'node:path';
import {
  CUSTOMER_RETURN_ERROR_CODES,
  CUSTOMER_RETURN_ERROR_MESSAGES,
  CUSTOMER_RETURN_FAILURE_MESSAGE,
  CUSTOMER_RETURN_LINE_STATE_LABELS,
  CUSTOMER_RETURN_RATE_LIMITED_MESSAGE,
  CUSTOMER_RETURN_STATUS_TEXT,
  isCustomerReturnErrorCode,
} from '@/lib/orders/returns/customer-return-messages';
import { CUSTOMER_RETURN_STATUSES } from '@/lib/orders/returns/customer-return-types';
import { RETURN_ERROR_MESSAGES } from '@/lib/orders/returns/return-messages';
import { RETURN_ERROR_CODES } from '@/lib/orders/returns/return-types';

// 共通の約束 C-4 のお客様の欄。言葉を直す時は、画面と文書の言葉も一緒に直すため、ここは1字も変えずに写す
const EXPECTED = [
  ['RETURN_NOT_ELIGIBLE', 409, 'お申し込みいただけない商品が含まれています。画面を開き直してください。'],
  ['RETURN_REQUESTS_CLOSED', 409, '現在、返品・交換のお申し込みを受け付けていません。'],
  ['RETURN_PHOTO_INVALID', 400, '写真を確かめてください（JPEG・PNG、1枚10MBまで、1つの商品に5枚まで）。'],
  ['RETURN_CUSTOMER_NOTE_REQUIRED', 400, '「破損・不良」「その他」の時は、詳しい内容を入れてください（300字まで）。'],
  ['RETURN_QUANTITY_EXCEEDS', 409, 'お申し込みいただける数を超えています。画面を開き直してください。'],
  ['RETURN_REQUEST_MISMATCH', 409, 'お申し込みの内容が変わりました。画面を開き直してください。'],
  ['RETURN_EXCHANGE_VARIANT_INVALID', 400, '交換する色・サイズを選び直してください。'],
  ['RETURN_ARGUMENT_INVALID', 400, '入力を確かめてください。'],
  ['ORDER_NOT_RETURNABLE', 409, 'この注文は、返品・交換のお申し込みを受け付けていません。'],
  ['CANCEL_REQUEST_EXISTS', 409, 'キャンセルのお申し込みは、すでに受け付けています。'],
  ['CANCEL_REQUEST_NOT_ELIGIBLE', 409, 'この注文は、キャンセルのお申し込みを受け付けていません。'],
  ['CANCEL_REQUEST_QUANTITY_EXCEEDS', 409, 'お申し込みいただける数を超えています。画面を開き直してください。'],
] as const;

// C-4 のお客様の欄が「—」の記号。お客様の窓口からは出ないので、この表に入れない
const NOT_FOR_CUSTOMERS = [
  'RETURN_DECLINE_MESSAGE_REQUIRED',
  'CANCEL_REQUEST_NOT_FOUND',
  'CANCEL_REQUEST_STATE_CONFLICT',
  'CANCEL_REQUEST_RESOLUTION_INVALID',
] as const;

describe('お客様の誤りの記号ごとの HTTP と言葉（共通の約束 C-4）', () => {
  it.each(EXPECTED)('%s は %i、言葉は「%s」', (code, status, message) => {
    expect(CUSTOMER_RETURN_ERROR_MESSAGES[code]).toEqual({ status, message });
  });

  it('表は、お客様の言葉がある12の記号を過不足なく持つ（記号を足したら言葉と HTTP も要る）', () => {
    const codes = [...CUSTOMER_RETURN_ERROR_CODES].sort();

    expect(EXPECTED.map(([code]) => code).sort()).toEqual(codes);
    expect(Object.keys(CUSTOMER_RETURN_ERROR_MESSAGES).sort()).toEqual(codes);
    expect(codes).toHaveLength(12);
  });

  it('全部の記号に言葉と HTTP がある（空の言葉・400 404 409 以外の HTTP は無い）', () => {
    for (const code of CUSTOMER_RETURN_ERROR_CODES) {
      const entry = CUSTOMER_RETURN_ERROR_MESSAGES[code];
      expect(entry.message).not.toBe('');
      expect([400, 404, 409]).toContain(entry.status);
    }
  });

  it('お客様の記号は、窓口の誤りの記号（RETURN_ERROR_CODES）の一部で、HTTP は管理画面の表と同じ', () => {
    for (const code of CUSTOMER_RETURN_ERROR_CODES) {
      expect(RETURN_ERROR_CODES).toContain(code);
      expect(CUSTOMER_RETURN_ERROR_MESSAGES[code].status).toBe(RETURN_ERROR_MESSAGES[code].status);
    }
  });

  it.each(NOT_FOR_CUSTOMERS)('お客様の言葉が「—」の %s は、表に入れない（お客様の窓口からは出ない）', (code) => {
    expect(RETURN_ERROR_CODES).toContain(code);
    expect(CUSTOMER_RETURN_ERROR_CODES as readonly string[]).not.toContain(code);
    expect(Object.keys(CUSTOMER_RETURN_ERROR_MESSAGES)).not.toContain(code);
    expect(isCustomerReturnErrorCode(code)).toBe(false);
  });

  it('isCustomerReturnErrorCode は、お客様の言葉がある記号だけ真（E-2 の記号・知らない言葉・空は偽）', () => {
    for (const code of CUSTOMER_RETURN_ERROR_CODES) {
      expect(isCustomerReturnErrorCode(code)).toBe(true);
    }
    for (const other of ['order_not_found', 'RETURN_FORBIDDEN', 'RETURN_UNKNOWN_WORD', '']) {
      expect(isCustomerReturnErrorCode(other)).toBe(false);
    }
  });

  it('お客様の言葉に、お店の中の言葉（店長・管理画面）や記号の綴りを出さない', () => {
    for (const code of CUSTOMER_RETURN_ERROR_CODES) {
      const { message } = CUSTOMER_RETURN_ERROR_MESSAGES[code];
      expect(message).not.toMatch(/店長|管理画面|サポート/);
      expect(message).not.toMatch(/[A-Z]+_[A-Z]+/);
    }
  });
});

describe('お客様の注文の画面の返品の状態の言葉（共通の約束 C-5）', () => {
  it('8つの状態の言葉と、添える決まった文', () => {
    expect(CUSTOMER_RETURN_STATUS_TEXT).toEqual({
      requested: { label: 'お申し込み中', note: '内容を確かめて、メールでご連絡します。' },
      accepted: { label: '返品の受付済み', note: null },
      partially_received: { label: '一部をお受け取りしました', note: '残りの商品の返送のしかたは、下のとおりです。' },
      inspecting: { label: 'お受け取りしました（確かめています）', note: '確かめてから、ご連絡します。' },
      awaiting_fee: { label: 'お支払いをお待ちしています', note: 'ご案内のメールをご覧ください。' },
      refund_preparing: { label: 'ご返金の準備中', note: null },
      returned: { label: '返品済み', note: null },
      declined: { label: 'お受けできませんでした', note: null },
    });
  });

  it('状態の並びは customer-return-types.ts と同じ（状態を足したら言葉も要る）', () => {
    expect(Object.keys(CUSTOMER_RETURN_STATUS_TEXT)).toEqual([...CUSTOMER_RETURN_STATUSES]);
    expect([...CUSTOMER_RETURN_STATUSES]).toEqual([
      'requested', 'accepted', 'partially_received', 'inspecting', 'awaiting_fee', 'refund_preparing', 'returned', 'declined',
    ]);
  });

  it('選べない品の言葉（選べる品 selectable には言葉が無い）', () => {
    expect(CUSTOMER_RETURN_LINE_STATE_LABELS).toEqual({
      past_deadline: '受付の期限を過ぎました',
      requested: 'お申し込み済み',
      sent_back: 'お返しした商品のため、お申し込みいただけません',
      unavailable: 'お申し込みいただける数がありません',
    });
    expect(Object.keys(CUSTOMER_RETURN_LINE_STATE_LABELS)).not.toContain('selectable');
  });

  it('想定外の失敗と回数の制限の言葉', () => {
    expect(CUSTOMER_RETURN_FAILURE_MESSAGE).toBe('お申し込みを受け付けられませんでした。時間をおいて、もう一度お試しください。');
    expect(CUSTOMER_RETURN_RATE_LIMITED_MESSAGE).toBe('しばらくしてから、もう一度お試しください。');
  });
});

describe('画面からも読めること', () => {
  const SCREEN_FILES: Array<[file: string, imports: string[], valueImports: string[]]> = [
    [
      'src/lib/orders/returns/customer-return-types.ts',
      ['@/lib/orders/order-payment-types', '@/lib/orders/returns/return-types'],
      [],
    ],
    [
      'src/lib/orders/returns/customer-return-messages.ts',
      ['@/lib/orders/returns/customer-return-types', '@/lib/orders/returns/return-types'],
      [],
    ],
  ];

  it.each(SCREEN_FILES)('%s はサーバーだけの物を import しない（型だけの import に限る）', (file, expected, expectedValueImports) => {
    const source = fs.readFileSync(path.join(process.cwd(), file), 'utf8');
    const specifiers = [...source.matchAll(/from '([^']+)'/g)].map((match) => match[1]);
    const valueImports = [...source.matchAll(/^import (?!type\b)[^;]*?from '([^']+)'/gm)].map((match) => match[1]);

    expect([...specifiers].sort()).toEqual([...expected].sort());
    expect([...valueImports].sort()).toEqual([...expectedValueImports].sort());
  });
});
