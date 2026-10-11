import {
  REFUND_ERROR_MESSAGES,
  refundErrorBody,
  stripeRejectedBody,
  unknownOutcomeBody,
} from '@/lib/orders/refund/refund-messages';
import type { RefundSubmitResult } from '@/lib/orders/refund/refund-service';
import { RefundOperationError, RefundStoreError } from '@/lib/orders/refund/refund-store';
import type { RefundAcceptedResponse, RefundErrorResponse } from '@/lib/orders/refund/refund-types';

/**
 * 返金の流れの答え（RefundSubmitResult）を、窓口の HTTP と監査に直す（グループ E-2 設計書 5-2・5-4）。
 * 返金の窓口・返事待ちの確かめ直しの窓口・状態の窓口の支払い済みのキャンセルが、同じ答えを返すための1か所。
 * 監査の鍵は maskAuditEvent に伏せられない名前にし、メモ・連絡先・Stripe の誤りの文は入れない。
 */
export type RefundReply = {
  status: number;
  body: RefundAcceptedResponse | RefundErrorResponse;
  audit: {
    outcome: 'success' | 'conflict' | 'failure' | 'error';
    detail: string;
    metadata: Record<string, unknown>;
  };
};

export function toRefundReply(result: RefundSubmitResult): RefundReply {
  switch (result.kind) {
    case 'accepted':
      return {
        status: 200,
        body: { refundId: result.refundId, status: result.status, amount: result.amount, replayed: result.replayed },
        audit: {
          outcome: 'success',
          detail: 'Refund accepted',
          metadata: { refund_id: result.refundId, status: result.status, amount: result.amount, replayed: result.replayed },
        },
      };
    case 'refused': {
      const { status } = REFUND_ERROR_MESSAGES[result.code];
      return {
        status,
        body: refundErrorBody(result.code),
        audit: { outcome: status === 409 ? 'conflict' : 'failure', detail: 'Refund refused', metadata: { code: result.code } },
      };
    }
    case 'stripe_rejected':
      return {
        status: 422,
        body: { ...stripeRejectedBody(result.reasonLabel), refundId: result.refundId },
        audit: { outcome: 'failure', detail: 'Stripe rejected the refund', metadata: { refund_id: result.refundId } },
      };
    case 'unknown':
      // Stripe は返金を作ったかもしれない。記録の番号を返し、画面が開き直した後も「もう一度確かめる」で確かめ直せるようにする
      return {
        status: 502,
        body: unknownOutcomeBody(result.refundId),
        audit: { outcome: 'error', detail: 'Refund outcome is unknown', metadata: { refund_id: result.refundId } },
      };
  }
}

/**
 * 窓口の失敗のログに出す物。誤りの名前と DB の記号だけにする
 * （DB の文には宛先・氏名・メールが混ざりうるので、出さない）。
 */
export function refundErrorLogFields(error: unknown): string[] {
  const name = error instanceof Error ? error.name : 'UnknownError';
  const code = error instanceof RefundStoreError || error instanceof RefundOperationError ? error.code : null;
  return code ? [name, code] : [name];
}
