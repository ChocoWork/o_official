// maskAuditEvent を読む @/lib/audit が、本物のサーバー用の部品を読み込まないようにする
jest.mock('@/lib/supabase/server', () => ({ createServiceRoleClient: jest.fn() }));

import { maskAuditEvent } from '@/lib/audit';
import {
  REFUND_ERROR_MESSAGES,
  UNKNOWN_REFUND_OUTCOME_MESSAGE,
  refundErrorBody,
} from '@/lib/orders/refund/refund-messages';
import { refundErrorLogFields, toRefundReply } from '@/lib/orders/refund/refund-route-support';
import { RefundOperationError, RefundStoreError } from '@/lib/orders/refund/refund-store';
import { REFUND_ERROR_CODES } from '@/lib/orders/refund/refund-types';

const REFUND_ID = 'c1b2c3d4-1111-4222-8333-444455556666';
const UNKNOWN_MESSAGE = '返金の結果を確かめられませんでした。「もう一度確かめる」を押すと、二重にならずに確かめ直します。';

describe('toRefundReply（返金の流れの答えを HTTP と監査に直す）', () => {
  it('受け付けた答えは 200。記録の番号・状態・額・送り直しかを返し、監査は成功', () => {
    expect(toRefundReply({ kind: 'accepted', refundId: REFUND_ID, status: 'pending', amount: 12000, replayed: false })).toEqual({
      status: 200,
      body: { refundId: REFUND_ID, status: 'pending', amount: 12000, replayed: false },
      audit: {
        outcome: 'success',
        detail: 'Refund accepted',
        metadata: { refund_id: REFUND_ID, status: 'pending', amount: 12000, replayed: false },
      },
    });
  });

  it('成功したことも、同じ番号の送り直し（replayed）も、そのまま写す', () => {
    const reply = toRefundReply({ kind: 'accepted', refundId: REFUND_ID, status: 'succeeded', amount: 500, replayed: true });

    expect(reply.status).toBe(200);
    expect(reply.body).toEqual({ refundId: REFUND_ID, status: 'succeeded', amount: 500, replayed: true });
    expect(reply.audit.metadata).toEqual({ refund_id: REFUND_ID, status: 'succeeded', amount: 500, replayed: true });
  });

  it.each(REFUND_ERROR_CODES)('DB の断り %s は、記号の HTTP と画面の言葉に直す。409 は衝突、ほかは失敗として監査に残す', (code) => {
    const reply = toRefundReply({ kind: 'refused', code });

    expect(reply.status).toBe(REFUND_ERROR_MESSAGES[code].status);
    expect(reply.body).toEqual(refundErrorBody(code));
    expect(reply.audit).toEqual({
      outcome: REFUND_ERROR_MESSAGES[code].status === 409 ? 'conflict' : 'failure',
      detail: 'Refund refused',
      metadata: { code },
    });
  });

  it('Stripe の断りは 422。理由の言葉があれば括弧で添え、記録の番号を付ける', () => {
    const reply = toRefundReply({ kind: 'stripe_rejected', refundId: REFUND_ID, reasonLabel: 'カード会社に断られました' });

    expect(reply.status).toBe(422);
    expect(reply.body).toEqual({
      error: 'Stripe が返金を受け付けませんでした（カード会社に断られました）。',
      code: 'stripe_rejected',
      refundId: REFUND_ID,
    });
    expect(reply.audit).toEqual({ outcome: 'failure', detail: 'Stripe rejected the refund', metadata: { refund_id: REFUND_ID } });
  });

  it('Stripe の断りに理由の言葉が無ければ、括弧を付けない', () => {
    expect(toRefundReply({ kind: 'stripe_rejected', refundId: REFUND_ID, reasonLabel: null }).body).toEqual({
      error: 'Stripe が返金を受け付けませんでした。',
      code: 'stripe_rejected',
      refundId: REFUND_ID,
    });
  });

  // Review Focus 1: 通信が切れて Stripe が返金を作ったか分からない。画面が開き直した後も確かめ直せるよう、記録の番号を返す
  it('答えが分からない時は 502 で、決まった文と記録の番号を返す。監査は error', () => {
    const reply = toRefundReply({ kind: 'unknown', refundId: REFUND_ID });

    expect(UNKNOWN_REFUND_OUTCOME_MESSAGE).toBe(UNKNOWN_MESSAGE);
    expect(reply.status).toBe(502);
    expect(reply.body).toEqual({ error: UNKNOWN_MESSAGE, code: 'unknown_outcome', refundId: REFUND_ID });
    expect(reply.audit).toEqual({ outcome: 'error', detail: 'Refund outcome is unknown', metadata: { refund_id: REFUND_ID } });
  });

  it.each([
    { kind: 'accepted', refundId: REFUND_ID, status: 'pending', amount: 1, replayed: false },
    { kind: 'refused', code: 'must_be_full' },
    { kind: 'stripe_rejected', refundId: REFUND_ID, reasonLabel: null },
    { kind: 'unknown', refundId: REFUND_ID },
  ] as const)('監査の鍵は、実物の maskAuditEvent を通しても伏せられない（$kind）', (result) => {
    const { audit } = toRefundReply(result);

    expect(maskAuditEvent({ action: 'admin.orders.refund.create', outcome: audit.outcome, metadata: audit.metadata }).metadata).toEqual(
      audit.metadata,
    );
  });
});

describe('refundErrorLogFields（窓口の失敗のログに出す物）', () => {
  it('DB の記号を持つ誤りは、名前と記号だけ。DB の文は出さない', () => {
    const error = new RefundStoreError('begin_order_refund', { message: '宛先・氏名を含む DB の文', code: '08006' });

    expect(refundErrorLogFields(error)).toEqual(['RefundStoreError', '08006']);
  });

  it('DB の記号が無ければ、名前だけ', () => {
    expect(refundErrorLogFields(new RefundStoreError('begin_order_refund', { message: 'x' }))).toEqual(['RefundStoreError']);
  });

  it('DB が決まった言葉で断った誤りは、名前と誤りの記号', () => {
    expect(refundErrorLogFields(new RefundOperationError('exceeds_refundable'))).toEqual(['RefundOperationError', 'exceeds_refundable']);
  });

  it('それ以外の誤りは名前だけ。誤りでない物を投げられても UnknownError と出す', () => {
    expect(refundErrorLogFields(new TypeError('Stripe のキーが無い'))).toEqual(['TypeError']);
    expect(refundErrorLogFields('文字')).toEqual(['UnknownError']);
  });
});
