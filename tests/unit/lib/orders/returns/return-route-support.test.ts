/** @jest-environment node */

// jest の共通の初期設定（tests/setupRequestPolyfill.js）が Response を node-fetch のものに差し替え、静的な json() が無い。NextResponse.json が内部で使うため補う
if (typeof (Response as unknown as { json?: unknown }).json !== 'function') {
  (Response as unknown as { json: unknown }).json = (body: unknown, init?: ResponseInit) =>
    new Response(JSON.stringify(body), {
      ...init,
      headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    });
}

const mockAuthorize = jest.fn();
jest.mock('@/lib/auth/admin-rbac', () => ({
  authorizeAdminPermission: (...args: unknown[]) => mockAuthorize(...args),
}));
const mockRequireCsrf = jest.fn();
jest.mock('@/lib/csrfMiddleware', () => ({ requireCsrfOrDeny: (...args: unknown[]) => mockRequireCsrf(...args) }));
const mockEnforceRateLimit = jest.fn();
jest.mock('@/features/auth/middleware/rateLimit', () => ({
  enforceRateLimit: (...args: unknown[]) => mockEnforceRateLimit(...args),
}));
const mockLogAudit = jest.fn().mockResolvedValue(undefined);
jest.mock('@/lib/audit', () => ({ logAudit: (...args: unknown[]) => mockLogAudit(...args) }));
jest.mock('@/lib/supabase/server', () => ({ createServiceRoleClient: jest.fn() }));

import { RefundOperationError, RefundStoreError } from '@/lib/orders/refund/refund-store';
import { REFUND_ERROR_CODES } from '@/lib/orders/refund/refund-types';
import {
  MAX_AMOUNT,
  MAX_FEE_YEN,
  RETURN_FAILURE_MESSAGES,
  RETURN_RATE_LIMITS,
  createReturnAudit,
  guardReturnWrite,
  optionalAmount,
  optionalCarrier,
  optionalText,
  optionalTrackingNumber,
  refusalCodeOf,
  resolveCanRefund,
  respondToRefusal,
  respondToReturnError,
  respondToReturnReadError,
  returnErrorLogFields,
  returnFailureBody,
  toReceiveReply,
  toRefundReturnReply,
  toRefusalReply,
} from '@/lib/orders/returns/return-route-support';
import type { ReceiveReturnResult, RefundReturnResult } from '@/lib/orders/returns/return-service';
import { ReturnStoreError } from '@/lib/orders/returns/return-store';
import { RETURN_ERROR_CODES } from '@/lib/orders/returns/return-types';
import { C4_CASES, E2_CASES, HEADERS, RECEIPT_ID, REFUND_ID, RETURN_ID, UNKNOWN_MESSAGE } from './return-route-fixtures';

const ADMIN = { ok: true, userId: 'admin-1', role: 'admin', actorEmail: 'admin@example.com' };
const DENIED = new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403 });

/** 持っている権限だけを通す認可の差し替え。それ以外は 403 */
function grant(...permissions: string[]) {
  mockAuthorize.mockImplementation(async (permission: string) =>
    permissions.includes(permission) ? ADMIN : { ok: false, response: DENIED },
  );
}

function postRequest(extraHeaders: Record<string, string> = {}) {
  return new Request(`http://localhost/api/admin/returns/${RETURN_ID}/cancel`, {
    method: 'POST',
    headers: { ...HEADERS, ...extraHeaders },
  });
}

/** 実物の maskAuditEvent を通しても、監査の鍵が [REDACTED] にならないこと（number・card などを含む鍵は伏せられてしまう） */
function expectNoKeyIsRedacted(metadata: Record<string, unknown>) {
  const { maskAuditEvent } = jest.requireActual('@/lib/audit');
  expect(maskAuditEvent({ action: 'x', outcome: 'success', metadata }).metadata).toEqual(metadata);
}

beforeEach(() => {
  jest.clearAllMocks();
  mockAuthorize.mockReset();
  mockRequireCsrf.mockReset();
  mockEnforceRateLimit.mockReset();
  grant('admin.orders.return', 'admin.orders.refund');
  mockRequireCsrf.mockResolvedValue(undefined);
  mockEnforceRateLimit.mockResolvedValue(undefined);
});

describe('計画の冒頭の値（回数の制限の窓口名と回数・500 の言葉・手数料の上限）', () => {
  it('回数の制限は 作る・受け取り・額を決めて返金が10分に30回、取消などが10分に60回', () => {
    expect(RETURN_RATE_LIMITS).toEqual({
      create: { endpoint: 'admin:returns:create', limit: 30, windowSeconds: 600 },
      receive: { endpoint: 'admin:returns:receive', limit: 30, windowSeconds: 600 },
      refund: { endpoint: 'admin:returns:refund', limit: 30, windowSeconds: 600 },
      update: { endpoint: 'admin:returns:update', limit: 60, windowSeconds: 600 },
    });
  });

  it('思いがけない失敗（500）の言葉は6つ。記号は E-2 と同じ failed', () => {
    expect(RETURN_FAILURE_MESSAGES).toEqual({
      list: '返品の一覧を読み込めませんでした。',
      materials: '返品の材料を読み込めませんでした。',
      create: '返品の記録に失敗しました。',
      receive: '受け取りの記録に失敗しました。',
      refund: '返金の記録に失敗しました。',
      update: '返品の更新に失敗しました。',
    });
    expect(returnFailureBody('receive')).toEqual({ error: '受け取りの記録に失敗しました。', code: 'failed' });
  });

  it('手数料の円の欄の上限は 1000000（Global Constraints の金額の上限。DB・画面と同じ値）', () => {
    expect(MAX_FEE_YEN).toBe(1000000);
  });
});

describe('本文の zod の部品（画面が使わない欄を null で送る本文と、額の 0 を受ける。Task 9）', () => {
  describe('optionalText（店だけのメモ・お返しのメッセージなどの文）', () => {
    const text = optionalText(500);

    it.each<[string, unknown]>([
      ['省く', undefined],
      ['null', null],
      ['空の文', ''],
      ['空白と改行だけ', '  \n '],
    ])('%s は null にする（空は持たない）', (_name, value) => {
      expect(text.parse(value)).toBeNull();
    });

    it('前後の空白を除いた文を返す。上限は空白を除いた後の文字数で数える', () => {
      expect(text.parse('  袖の汚れなし ')).toBe('袖の汚れなし');
      expect(text.parse(`  ${'あ'.repeat(500)}  `)).toBe('あ'.repeat(500));
    });

    it.each<[string, unknown]>([
      ['上限を超える文字数', 'あ'.repeat(501)],
      ['数', 5],
      ['真偽', true],
      ['配列', ['メモ']],
    ])('%s は誤り', (_name, value) => {
      expect(text.safeParse(value).success).toBe(false);
    });
  });

  describe('optionalAmount（金額。省く／null は計算どおり、0 は返金しないで終える）', () => {
    it.each<[string, unknown, number | null]>([
      ['省く', undefined, null],
      ['null', null, null],
      ['0', 0, 0],
      ['8000', 8000, 8000],
      ['integer の上限', MAX_AMOUNT, MAX_AMOUNT],
    ])('%s は受ける。0 は 0 のまま、省く／null は null のまま渡す', (_name, value, expected) => {
      expect(optionalAmount.parse(value)).toBe(expected);
    });

    it.each<[string, unknown]>([
      ['負', -1],
      ['小数', 100.5],
      ['integer の上限を超える', MAX_AMOUNT + 1],
      ['文字', '100'],
      ['数でない値', Number.NaN],
    ])('%s は誤り', (_name, value) => {
      expect(optionalAmount.safeParse(value).success).toBe(false);
    });
  });

  describe('optionalCarrier・optionalTrackingNumber（送り返し・返送の配送業者と伝票番号）', () => {
    it.each<[string, unknown]>([
      ['省く', undefined],
      ['null', null],
    ])('配送業者が %s なら null', (_name, value) => {
      expect(optionalCarrier.parse(value)).toBeNull();
    });

    it('知っている配送業者はそのまま通し、知らない値と空の文は誤りにする', () => {
      expect(optionalCarrier.parse('yamato')).toBe('yamato');
      expect(optionalCarrier.safeParse('fedex').success).toBe(false);
      expect(optionalCarrier.safeParse('').success).toBe(false);
    });

    it.each<[string, unknown]>([
      ['省く', undefined],
      ['null', null],
      ['空の文', ''],
      ['空白だけ', '   '],
    ])('伝票番号が %s なら null', (_name, value) => {
      expect(optionalTrackingNumber.parse(value)).toBeNull();
    });

    it('伝票番号は前後の空白を除き、英数字とハイフンの1〜64文字だけ受ける', () => {
      expect(optionalTrackingNumber.parse(' AB-123 ')).toBe('AB-123');
      expect(optionalTrackingNumber.parse('a'.repeat(64))).toBe('a'.repeat(64));
      for (const value of ['AB 123', 'a'.repeat(65), '日本', 123]) {
        expect(optionalTrackingNumber.safeParse(value).success).toBe(false);
      }
    });
  });
});

describe('refusalCodeOf（DB が決まった言葉で断った誤りだけを見分ける）', () => {
  it.each(C4_CASES)('返品の store が %s で断った誤りは、その記号を返す', (code) => {
    expect(refusalCodeOf(new ReturnStoreError(code))).toBe(code);
  });

  it('store が E-2 の言葉をそのまま渡した誤り（記号は E-2 の物）も、断りとして返す', () => {
    expect(refusalCodeOf(new ReturnStoreError('awaiting_refund_exists'))).toBe('awaiting_refund_exists');
  });

  it('E-2 の RefundOperationError も断りとして返す', () => {
    expect(refusalCodeOf(new RefundOperationError('exceeds_refundable'))).toBe('exceeds_refundable');
  });

  it('知らない記号（DB の SQLSTATE など）を持つ ReturnStoreError や、ほかの誤りは断りではない（500 にする）', () => {
    expect(refusalCodeOf(new ReturnStoreError('08006' as never))).toBeNull();
    expect(refusalCodeOf(new RefundStoreError('create_return', { message: 'DB の文', code: '08006' }))).toBeNull();
    expect(refusalCodeOf(new TypeError('Stripe のキーが無い'))).toBeNull();
    expect(refusalCodeOf('文字')).toBeNull();
    expect(refusalCodeOf(null)).toBeNull();
  });
});

describe('toRefusalReply（断りを HTTP・言葉・監査に直す）', () => {
  it('計画の冒頭 C-4 の表と E-2 の表の書き写しは、全部の記号を覆っている', () => {
    expect(C4_CASES.map(([code]) => code).sort()).toEqual([...RETURN_ERROR_CODES].sort());
    expect(E2_CASES.map(([code]) => code).sort()).toEqual([...REFUND_ERROR_CODES].sort());
  });

  it.each(C4_CASES)('%s は HTTP %i と C-4 の言葉。409 は衝突、ほかは失敗として監査に残す', (code, status, message) => {
    expect(toRefusalReply(code, 'Return refused')).toEqual({
      status,
      body: { error: message, code },
      audit: { outcome: status === 409 ? 'conflict' : 'failure', detail: 'Return refused', metadata: { code } },
    });
  });

  it.each(E2_CASES)('E-2 の記号 %s は E-2 の HTTP %i と言葉のまま', (code, status, message) => {
    expect(toRefusalReply(code, 'Return refused')).toEqual({
      status,
      body: { error: message, code },
      audit: { outcome: status === 409 ? 'conflict' : 'failure', detail: 'Return refused', metadata: { code } },
    });
  });
});

describe('toReceiveReply（受け取りの流れの答えを HTTP と監査に直す）', () => {
  // satisfies にして、kind: 'received' の型のまま下で上書き（{ ...RECEIVED, refund: null } など）できるようにする
  const RECEIVED = {
    kind: 'received',
    receiptId: RECEIPT_ID,
    returnStatus: 'closed',
    refund: { refundId: REFUND_ID, amount: 8000, status: 'pending' },
    feeDueAmount: 0,
    exchangeOrderItemIds: [],
    replayed: false,
  } satisfies ReceiveReturnResult;

  it('今返金して Stripe が受け付けた答えは 200。受け取りと返金の番号・状態・額を data に入れ、監査は成功', () => {
    expect(toReceiveReply(RECEIVED)).toEqual({
      status: 200,
      body: {
        data: {
          receiptId: RECEIPT_ID, returnStatus: 'closed', refundId: REFUND_ID, refundAmount: 8000,
          refundStatus: 'pending', feeDueAmount: 0, replayed: false,
        },
      },
      audit: {
        outcome: 'success',
        detail: 'Return received',
        metadata: {
          receipt_id: RECEIPT_ID, return_status: 'closed', refund_id: REFUND_ID, refund_amount: 8000,
          refund_status: 'pending', fee_due_amount: 0, replayed: false,
        },
      },
    });
  });

  it('返金の無い受け取り（相談・なし）は、返金の3つの欄が null。お支払い待ちの額はそのまま返す', () => {
    const reply = toReceiveReply({ ...RECEIVED, returnStatus: 'open', refund: null, feeDueAmount: 300 });

    expect(reply.status).toBe(200);
    expect(reply.body).toEqual({
      data: {
        receiptId: RECEIPT_ID, returnStatus: 'open', refundId: null, refundAmount: null,
        refundStatus: null, feeDueAmount: 300, replayed: false,
      },
    });
    expect(reply.audit.metadata).toEqual(expect.objectContaining({ refund_id: null, refund_amount: null, refund_status: null }));
  });

  // 計画の冒頭 P20: 手数料が商品の額以上で返金が0円になった。返金の記録も Stripe への頼みも無い
  it('返金が0円で省かれた受け取りは、返金の番号が null・額が 0・状態が waived', () => {
    const reply = toReceiveReply({ ...RECEIVED, refund: { refundId: null, amount: 0, status: 'waived' }, feeDueAmount: 200 });

    expect(reply.status).toBe(200);
    expect(reply.body).toEqual({
      data: {
        receiptId: RECEIPT_ID, returnStatus: 'closed', refundId: null, refundAmount: 0,
        refundStatus: 'waived', feeDueAmount: 200, replayed: false,
      },
    });
    expect(reply.audit.metadata).toEqual(expect.objectContaining({ refund_id: null, refund_amount: 0, refund_status: 'waived' }));
  });

  // Review Focus 1: 同じ二重防止の番号の送り直しは、前の受け取りと返金の記録を返す（replayed）。200 のまま写す
  it('同じ番号の送り直し（replayed）は、そのまま写す', () => {
    const reply = toReceiveReply({ ...RECEIVED, replayed: true });

    expect(reply.status).toBe(200);
    expect(reply.body).toEqual({ data: expect.objectContaining({ replayed: true }) });
    expect(reply.audit.metadata).toEqual(expect.objectContaining({ replayed: true }));
  });

  it.each(C4_CASES)('断り %s は C-4 の言葉。受け取りの断りとして監査に残す', (code, status, message) => {
    expect(toReceiveReply({ kind: 'refused', code })).toEqual({
      status,
      body: { error: message, code },
      audit: { outcome: status === 409 ? 'conflict' : 'failure', detail: 'Return receive refused', metadata: { code } },
    });
  });

  it('E-2 の断り（確かめ中の返金がある）は E-2 の言葉のまま', () => {
    expect(toReceiveReply({ kind: 'refused', code: 'awaiting_refund_exists' })).toEqual({
      status: 409,
      body: { error: '確かめ中の返金があります。先に確かめてください。', code: 'awaiting_refund_exists' },
      audit: { outcome: 'conflict', detail: 'Return receive refused', metadata: { code: 'awaiting_refund_exists' } },
    });
  });

  it('受け取りは記録できたが Stripe が断った時は 422。E-2 の言葉に返金の番号を付け、記録済みの受け取りの番号も付ける', () => {
    expect(toReceiveReply({
      kind: 'refund_not_accepted',
      receiptId: RECEIPT_ID,
      returnStatus: 'closed',
      refund: { kind: 'stripe_rejected', refundId: REFUND_ID, reasonLabel: 'カード会社に断られました' },
    })).toEqual({
      status: 422,
      body: {
        error: 'Stripe が返金を受け付けませんでした（カード会社に断られました）。',
        code: 'stripe_rejected',
        refundId: REFUND_ID,
        receiptId: RECEIPT_ID,
      },
      audit: {
        outcome: 'failure',
        detail: 'Stripe rejected the refund',
        metadata: { refund_id: REFUND_ID, receipt_id: RECEIPT_ID },
      },
    });
  });

  it('Stripe の断りに理由の言葉が無ければ、括弧を付けない', () => {
    const reply = toReceiveReply({
      kind: 'refund_not_accepted',
      receiptId: RECEIPT_ID,
      returnStatus: 'closed',
      refund: { kind: 'stripe_rejected', refundId: REFUND_ID, reasonLabel: null },
    });

    expect(reply.body).toEqual(expect.objectContaining({ error: 'Stripe が返金を受け付けませんでした。' }));
  });

  // Review Focus 1: 通信が切れて Stripe が返金を作ったか分からない。画面が開き直した後も確かめ直せるよう、番号を返す
  it('答えが分からない時は 502 で、決まった文と返金の番号・受け取りの番号を返す。監査は error', () => {
    expect(toReceiveReply({
      kind: 'refund_not_accepted',
      receiptId: RECEIPT_ID,
      returnStatus: 'closed',
      refund: { kind: 'unknown', refundId: REFUND_ID },
    })).toEqual({
      status: 502,
      body: { error: UNKNOWN_MESSAGE, code: 'unknown_outcome', refundId: REFUND_ID, receiptId: RECEIPT_ID },
      audit: {
        outcome: 'error',
        detail: 'Refund outcome is unknown',
        metadata: { refund_id: REFUND_ID, receipt_id: RECEIPT_ID },
      },
    });
  });

  it('受け取りは記録できたが E-2 が返金を断った時（支払いの番号が Stripe の物でない注文など）は、E-2 の言葉と HTTP に受け取りの番号を付ける', () => {
    expect(toReceiveReply({
      kind: 'refund_not_accepted',
      receiptId: RECEIPT_ID,
      returnStatus: 'open',
      refund: { kind: 'refused', code: 'order_not_refundable' },
    })).toEqual({
      status: 409,
      body: { error: 'この注文は返金できません。', code: 'order_not_refundable', receiptId: RECEIPT_ID },
      audit: { outcome: 'conflict', detail: 'Refund refused', metadata: { code: 'order_not_refundable', receipt_id: RECEIPT_ID } },
    });
  });

  it.each<ReceiveReturnResult>([
    RECEIVED,
    { ...RECEIVED, refund: { refundId: null, amount: 0, status: 'waived' } },
    { kind: 'refused', code: 'RETURN_STATE_CONFLICT' },
    { kind: 'refund_not_accepted', receiptId: RECEIPT_ID, returnStatus: 'closed', refund: { kind: 'stripe_rejected', refundId: REFUND_ID, reasonLabel: null } },
    { kind: 'refund_not_accepted', receiptId: RECEIPT_ID, returnStatus: 'closed', refund: { kind: 'unknown', refundId: REFUND_ID } },
  ])('監査の鍵は、実物の maskAuditEvent を通しても伏せられない（$kind）', (result) => {
    expectNoKeyIsRedacted(toReceiveReply(result).audit.metadata);
  });
});

describe('toRefundReturnReply（額を決めて返金の流れの答えを HTTP と監査に直す）', () => {
  it('受け付けた答えは 200。E-2 の返金の答えを data に入れ、監査は E-2 と同じ', () => {
    expect(toRefundReturnReply({ kind: 'accepted', refundId: REFUND_ID, status: 'pending', amount: 12000, replayed: false })).toEqual({
      status: 200,
      body: { data: { refundId: REFUND_ID, status: 'pending', amount: 12000, replayed: false } },
      audit: {
        outcome: 'success',
        detail: 'Refund accepted',
        metadata: { refund_id: REFUND_ID, status: 'pending', amount: 12000, replayed: false },
      },
    });
  });

  it('同じ番号の送り直し（replayed）の成功も、そのまま写す', () => {
    const reply = toRefundReturnReply({ kind: 'accepted', refundId: REFUND_ID, status: 'succeeded', amount: 500, replayed: true });

    expect(reply.body).toEqual({ data: { refundId: REFUND_ID, status: 'succeeded', amount: 500, replayed: true } });
  });

  // 計画の冒頭 P20: 額を決めて返金で0円にした。返金の記録も Stripe への頼みも無く、お客様への返金のお知らせも無い
  it('0円で返金しないで終えた答え（waived）は 200。返金の番号が null・額が 0・状態が waived', () => {
    expect(toRefundReturnReply({ kind: 'waived', replayed: false })).toEqual({
      status: 200,
      body: { data: { refundId: null, amount: 0, status: 'waived', replayed: false } },
      audit: {
        outcome: 'success',
        detail: 'Refund waived',
        metadata: { refund_id: null, status: 'waived', amount: 0, replayed: false },
      },
    });
    expect(toRefundReturnReply({ kind: 'waived', replayed: true }).body).toEqual({
      data: { refundId: null, amount: 0, status: 'waived', replayed: true },
    });
  });

  it.each(C4_CASES)('断り %s は C-4 の言葉。額を決めて返金の断りとして監査に残す', (code, status, message) => {
    expect(toRefundReturnReply({ kind: 'refused', code })).toEqual({
      status,
      body: { error: message, code },
      audit: { outcome: status === 409 ? 'conflict' : 'failure', detail: 'Return refund refused', metadata: { code } },
    });
  });

  it('Stripe の断りは 422、答えが分からない時は 502。どちらも E-2 の言葉に返金の番号を付ける', () => {
    expect(toRefundReturnReply({ kind: 'stripe_rejected', refundId: REFUND_ID, reasonLabel: null })).toEqual({
      status: 422,
      body: { error: 'Stripe が返金を受け付けませんでした。', code: 'stripe_rejected', refundId: REFUND_ID },
      audit: { outcome: 'failure', detail: 'Stripe rejected the refund', metadata: { refund_id: REFUND_ID } },
    });
    expect(toRefundReturnReply({ kind: 'unknown', refundId: REFUND_ID })).toEqual({
      status: 502,
      body: { error: UNKNOWN_MESSAGE, code: 'unknown_outcome', refundId: REFUND_ID },
      audit: { outcome: 'error', detail: 'Refund outcome is unknown', metadata: { refund_id: REFUND_ID } },
    });
  });

  it.each<RefundReturnResult>([
    { kind: 'accepted', refundId: REFUND_ID, status: 'pending', amount: 1, replayed: false },
    { kind: 'waived', replayed: false },
    { kind: 'refused', code: 'RETURN_NOTHING_TO_REFUND' },
    { kind: 'stripe_rejected', refundId: REFUND_ID, reasonLabel: null },
    { kind: 'unknown', refundId: REFUND_ID },
  ])('監査の鍵は、実物の maskAuditEvent を通しても伏せられない（$kind）', (result) => {
    expectNoKeyIsRedacted(toRefundReturnReply(result).audit.metadata);
  });
});

describe('returnErrorLogFields（窓口の失敗のログに出す物）', () => {
  it('DB の記号を持つ誤りは、名前と記号だけ。DB の文は出さない', () => {
    const error = new RefundStoreError('create_return', { message: '宛先・氏名を含む DB の文', code: '08006' });

    expect(returnErrorLogFields(error)).toEqual(['RefundStoreError', '08006']);
  });

  it('DB が決まった言葉で断った誤り（返品の store・E-2）は、名前と誤りの記号', () => {
    const returnError = new ReturnStoreError('RETURN_NOT_FOUND');

    expect(returnErrorLogFields(returnError)).toEqual([returnError.name, 'RETURN_NOT_FOUND']);
    expect(returnErrorLogFields(new RefundOperationError('exceeds_refundable'))).toEqual(['RefundOperationError', 'exceeds_refundable']);
  });

  it('DB の記号が無ければ名前だけ。誤りでない物を投げられても UnknownError と出す', () => {
    expect(returnErrorLogFields(new RefundStoreError('create_return', { message: 'x' }))).toEqual(['RefundStoreError']);
    expect(returnErrorLogFields(new TypeError('Stripe のキーが無い'))).toEqual(['TypeError']);
    expect(returnErrorLogFields('文字')).toEqual(['UnknownError']);
  });
});

describe('createReturnAudit（監査の書き込み）', () => {
  it('実行した人・対象・送信元を付けて logAudit に渡す。ip は x-forwarded-for の最初の値', async () => {
    const audit = createReturnAudit(postRequest(), 'admin-1', {
      action: 'admin.orders.return.cancel', resource: 'order_returns', resourceId: RETURN_ID,
    });

    await audit('success', 'Return cancelled', { return_status: 'cancelled' });

    expect(mockLogAudit).toHaveBeenCalledWith({
      action: 'admin.orders.return.cancel',
      actor_id: 'admin-1',
      resource: 'order_returns',
      resource_id: RETURN_ID,
      outcome: 'success',
      detail: 'Return cancelled',
      ip: '203.0.113.5',
      user_agent: 'jest',
      metadata: { return_status: 'cancelled' },
    });
  });

  it('送信元の情報が無い要求でも書ける。鍵を渡さなければ metadata は null', async () => {
    const request = new Request('http://localhost/api/admin/returns/x/cancel', { method: 'POST' });
    const audit = createReturnAudit(request, 'admin-1', { action: 'admin.orders.return.create', resource: 'orders', resourceId: 'x' });

    await audit('failure', 'Invalid order id');

    expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({
      resource: 'orders', resource_id: 'x', outcome: 'failure', detail: 'Invalid order id', ip: null, metadata: null,
    }));
    expect(mockLogAudit.mock.calls[0][0].user_agent).toBeNull();
  });
});

describe('guardReturnWrite（書く窓口の守り）', () => {
  const OPTIONS = { rateLimit: RETURN_RATE_LIMITS.update, requireRefundPermission: false };

  it('権限・CSRF・回数の制限が通れば、実行する人の番号を返す。回数は送信元ごと→管理者ごとに、渡した窓口名と回数で数える', async () => {
    const guard = await guardReturnWrite(postRequest(), OPTIONS);

    expect(guard).toEqual({ ok: true, userId: 'admin-1' });
    expect(mockAuthorize.mock.calls).toEqual([['admin.orders.return', expect.any(Request)]]);
    expect(mockEnforceRateLimit).toHaveBeenCalledTimes(2);
    expect(mockEnforceRateLimit).toHaveBeenNthCalledWith(1, {
      request: expect.any(Request), endpoint: 'admin:returns:update', limit: 60, windowSeconds: 600,
    });
    expect(mockEnforceRateLimit).toHaveBeenNthCalledWith(2, {
      request: expect.any(Request), endpoint: 'admin:returns:update', limit: 60, windowSeconds: 600, subject: 'admin-1',
    });
  });

  it('権限 admin.orders.return が無ければ、認可の応答を返し、CSRF も回数の制限も確かめない（権限の確認が先）', async () => {
    grant();

    const guard = await guardReturnWrite(postRequest(), OPTIONS);

    expect(guard.ok).toBe(false);
    if (!guard.ok) expect(guard.response).toBe(DENIED);
    expect(mockRequireCsrf).not.toHaveBeenCalled();
    expect(mockEnforceRateLimit).not.toHaveBeenCalled();
  });

  it('requireRefundPermission が真なら、admin.orders.return の次に admin.orders.refund も確かめる', async () => {
    const guard = await guardReturnWrite(postRequest(), { ...OPTIONS, requireRefundPermission: true });

    expect(guard).toEqual({ ok: true, userId: 'admin-1' });
    expect(mockAuthorize.mock.calls).toEqual([
      ['admin.orders.return', expect.any(Request)],
      ['admin.orders.refund', expect.any(Request)],
    ]);
  });

  it('requireRefundPermission が真で admin.orders.refund が無ければ、認可の応答を返し、CSRF も回数の制限も確かめない', async () => {
    grant('admin.orders.return');

    const guard = await guardReturnWrite(postRequest(), { ...OPTIONS, requireRefundPermission: true });

    expect(guard.ok).toBe(false);
    if (!guard.ok) expect(guard.response).toBe(DENIED);
    expect(mockRequireCsrf).not.toHaveBeenCalled();
    expect(mockEnforceRateLimit).not.toHaveBeenCalled();
  });

  it('CSRF の合言葉が合わなければ、その応答を返し、回数も数えない', async () => {
    const csrfDenied = new Response(null, { status: 403 });
    mockRequireCsrf.mockResolvedValueOnce(csrfDenied);

    const guard = await guardReturnWrite(postRequest(), OPTIONS);

    expect(guard.ok).toBe(false);
    if (!guard.ok) expect(guard.response).toBe(csrfDenied);
    expect(mockEnforceRateLimit).not.toHaveBeenCalled();
  });

  it('送信元ごとの回数の制限を超えたら、その応答を返し、管理者ごとの回数は数えない', async () => {
    const limited = new Response(null, { status: 429 });
    mockEnforceRateLimit.mockResolvedValueOnce(limited);

    const guard = await guardReturnWrite(postRequest(), OPTIONS);

    expect(guard.ok).toBe(false);
    if (!guard.ok) expect(guard.response).toBe(limited);
    expect(mockEnforceRateLimit).toHaveBeenCalledTimes(1);
  });

  it('管理者ごとの回数の制限を超えたら、その応答を返す', async () => {
    const limited = new Response(null, { status: 429 });
    mockEnforceRateLimit.mockResolvedValueOnce(undefined).mockResolvedValueOnce(limited);

    const guard = await guardReturnWrite(postRequest(), OPTIONS);

    expect(guard.ok).toBe(false);
    if (!guard.ok) expect(guard.response).toBe(limited);
  });
});

describe('resolveCanRefund（返金の権限を持つか）', () => {
  it('admin.orders.refund を持てば真', async () => {
    await expect(resolveCanRefund(postRequest())).resolves.toEqual({ ok: true, canRefund: true });
    expect(mockAuthorize).toHaveBeenCalledWith('admin.orders.refund', expect.any(Request));
  });

  it('持たない（403）なら偽。サポートの人は返品の窓口を使えるまま', async () => {
    grant('admin.orders.return');

    await expect(resolveCanRefund(postRequest())).resolves.toEqual({ ok: true, canRefund: false });
  });

  // 確かめられなかっただけの人を、黙ってサポートの扱いにしない（今返金を選んだ店長が「店長だけ」と言われないように）
  it.each([401, 503, 500])('確かめられなかった（%i）時は、偽にせず、その応答をそのまま返す', async (status) => {
    const failed = new Response(null, { status });
    mockAuthorize.mockResolvedValueOnce({ ok: false, response: failed });

    const result = await resolveCanRefund(postRequest());

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response).toBe(failed);
  });
});

describe('respondToRefusal（入口が答えで返した断り）', () => {
  it('断りの HTTP と言葉を返し、断りとして監査に残す', async () => {
    const audit = jest.fn().mockResolvedValue(undefined);

    const response = await respondToRefusal('RETURN_NOT_FOUND', { audit, refusedDetail: 'Return cancel refused' });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: '返品が見つかりません。', code: 'RETURN_NOT_FOUND' });
    expect(audit).toHaveBeenCalledWith('failure', 'Return cancel refused', { code: 'RETURN_NOT_FOUND' });
  });
});

describe('respondToReturnError（書く窓口の失敗の答え）', () => {
  const OPTIONS = {
    action: 'admin.orders.return.cancel',
    refusedDetail: 'Return cancel refused',
    failureDetail: 'Failed to cancel return',
    failureKind: 'update',
  } as const;

  it('決まった言葉で断られた誤りが投げられても、その HTTP と言葉を返し、断りとして監査に残す。ログは出さない', async () => {
    const audit = jest.fn().mockResolvedValue(undefined);
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const response = await respondToReturnError(new ReturnStoreError('RETURN_STATE_CONFLICT'), { ...OPTIONS, audit });

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toEqual({
        error: '返品の状態が変わりました。画面を開き直してください。',
        code: 'RETURN_STATE_CONFLICT',
      });
      expect(audit).toHaveBeenCalledWith('conflict', 'Return cancel refused', { code: 'RETURN_STATE_CONFLICT' });
      expect(consoleError).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });

  it('思いがけない失敗は 500。ログは窓口名つきの文と、例外名と DB の記号だけ（DB の文は出さない）。監査は error', async () => {
    const audit = jest.fn().mockResolvedValue(undefined);
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const error = new RefundStoreError('cancel_return', { message: '宛先・氏名を含む DB の文', code: '08006' });
      const response = await respondToReturnError(error, { ...OPTIONS, audit });

      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toEqual({ error: '返品の更新に失敗しました。', code: 'failed' });
      expect(consoleError.mock.calls).toEqual([['[admin.orders.return.cancel] Failed to cancel return', 'RefundStoreError', '08006']]);
      expect(audit).toHaveBeenCalledWith('error', 'Failed to cancel return');
    } finally {
      consoleError.mockRestore();
    }
  });

  it('DB の記号を持たない失敗は、例外名だけをログに出す', async () => {
    const audit = jest.fn().mockResolvedValue(undefined);
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const response = await respondToReturnError(new TypeError('STRIPE_SECRET_KEY is not set'), { ...OPTIONS, audit });

      expect(response.status).toBe(500);
      expect(consoleError.mock.calls).toEqual([['[admin.orders.return.cancel] Failed to cancel return', 'TypeError']]);
    } finally {
      consoleError.mockRestore();
    }
  });
});

describe('respondToReturnReadError（読む窓口の失敗の答え）', () => {
  it('決まった言葉で断られた時は、その HTTP と言葉を返す', async () => {
    const response = await respondToReturnReadError(new ReturnStoreError('ORDER_NOT_RETURNABLE'), {
      tag: '[admin.orders.return.materials] Failed to load materials', failureKind: 'materials',
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: 'この注文は返品を作れません。', code: 'ORDER_NOT_RETURNABLE' });
  });

  it('思いがけない失敗は 500。ログは窓口名つきの文と、例外名と DB の記号だけ', async () => {
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const error = new RefundStoreError('list_order_returns', { message: 'DB の文', code: '08006' });
      const response = await respondToReturnReadError(error, {
        tag: '[admin.orders.return.list] Failed to load returns', failureKind: 'list',
      });

      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toEqual({ error: '返品の一覧を読み込めませんでした。', code: 'failed' });
      expect(consoleError.mock.calls).toEqual([['[admin.orders.return.list] Failed to load returns', 'RefundStoreError', '08006']]);
    } finally {
      consoleError.mockRestore();
    }
  });
});
