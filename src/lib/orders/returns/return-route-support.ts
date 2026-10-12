import { NextResponse } from 'next/server';
import { z } from 'zod';
import { enforceRateLimit } from '@/features/auth/middleware/rateLimit';
import { authorizeAdminPermission } from '@/lib/auth/admin-rbac';
import { logAudit } from '@/lib/audit';
import { REFUND_ERROR_MESSAGES, refundErrorBody } from '@/lib/orders/refund/refund-messages';
import { toRefundReply, type RefundReply } from '@/lib/orders/refund/refund-route-support';
import { RefundOperationError, RefundStoreError } from '@/lib/orders/refund/refund-store';
import { REFUND_ERROR_CODES, type RefundErrorCode } from '@/lib/orders/refund/refund-types';
import { RETURN_ERROR_MESSAGES } from '@/lib/orders/returns/return-messages';
import type { ReceiveReturnResult, RefundReturnResult } from '@/lib/orders/returns/return-service';
import { ReturnStoreError } from '@/lib/orders/returns/return-store';
import { RETURN_CARRIERS, RETURN_ERROR_CODES, type ReturnErrorCode } from '@/lib/orders/returns/return-types';

/**
 * 返品の窓口が共有する部品（グループ E-3 Task 7、決め事 T7-1）。E-2 の refund-route-support.ts と同じ考えで、
 * 守りの順・断りの言葉・監査・ログを1か所に持ち、10本の窓口がずれないようにする。サーバーだけで使う。
 * 監査の鍵は maskAuditEvent に伏せられない名前にし（number・card・pan・token などを含めない）、
 * メモ・お返しのメッセージ・伝票番号・住所・メールは入れない。
 */

// ---- 回数の制限と 500 の言葉（計画の冒頭 Global Constraints） ----

export type RateLimitRule = { readonly endpoint: string; readonly limit: number; readonly windowSeconds: number };

export const RETURN_RATE_LIMITS = {
  create: { endpoint: 'admin:returns:create', limit: 30, windowSeconds: 600 },
  receive: { endpoint: 'admin:returns:receive', limit: 30, windowSeconds: 600 },
  refund: { endpoint: 'admin:returns:refund', limit: 30, windowSeconds: 600 },
  // 取消・開き直し・届かないで終える・検品・手数料の記録・支払いを待たずに送る
  update: { endpoint: 'admin:returns:update', limit: 60, windowSeconds: 600 },
} as const satisfies Record<string, RateLimitRule>;

/** 思いがけない失敗（500）の言葉。C-4・C-5 に無いので本タスクで決めた。何をしようとして失敗したかで分ける */
export const RETURN_FAILURE_MESSAGES = {
  list: '返品の一覧を読み込めませんでした。',
  materials: '返品の材料を読み込めませんでした。',
  create: '返品の記録に失敗しました。',
  receive: '受け取りの記録に失敗しました。',
  refund: '返金の記録に失敗しました。',
  update: '返品の更新に失敗しました。',
} as const;
export type ReturnFailureKind = keyof typeof RETURN_FAILURE_MESSAGES;

export function returnFailureBody(kind: ReturnFailureKind) {
  return { error: RETURN_FAILURE_MESSAGES[kind], code: 'failed' };
}

// ---- 本文の zod の部品 ----

// Postgres の integer の上限。これを超える額は DB が型の誤りで断って 500 になり、画面が同じ番号で送り直しを繰り返してしまうので、窓口で 400 にする
export const MAX_AMOUNT = 2147483647;

// 手数料の円の欄（返品を作る時の返送料・交換の手数料・交換の送料、設定の返送料の定額・交換の手数料・交換の送料）の上限。
// 計画の冒頭の Global Constraints の「金額の入力の上限は 1,000,000 円」。DB の関数（Task 2 の admin_create_return の RETURN_FEE_INVALID・
// admin_update_shop_return_settings の settings_int）と画面（Task 10・Task 12）と同じ値。返金の額は手数料ではない（DB が返せる額で確かめる）ので MAX_AMOUNT のまま
export const MAX_FEE_YEN = 1000000;

/** 店だけのメモ・お返しのメッセージなどの文。前後の空白を除き、空は持たない（null） */
export const optionalText = (maxLength: number) =>
  z.string().trim().max(maxLength).nullish().transform((value) => value || null);

/** 金額（円）。省いた時と null は、DB が設定の値・計算どおりで決める印。0 は 0 のまま渡す（返金しないで終える意味。P20） */
export const optionalAmount = z.number().int().min(0).max(MAX_AMOUNT).nullish().transform((value) => value ?? null);

export const optionalCarrier = z.enum(RETURN_CARRIERS).nullish().transform((value) => value ?? null);

/** 伝票番号（P16。E-1 と同じ ^[0-9A-Za-z-]{1,64}$）。空は持たない（null） */
export const optionalTrackingNumber = z
  .string()
  .trim()
  .nullish()
  .transform((value) => value || null)
  .refine((value) => value === null || /^[0-9A-Za-z-]{1,64}$/.test(value));

// ---- 答えの対応 ----

export type AuditOutcome = 'success' | 'failure' | 'conflict' | 'error';

/** 窓口の HTTP の答えと、監査に残す結果・文・鍵 */
export type ReturnReply = {
  status: number;
  body: Record<string, unknown>;
  audit: { outcome: AuditOutcome; detail: string; metadata: Record<string, unknown> };
};

function isReturnErrorCode(code: string): code is ReturnErrorCode {
  return (RETURN_ERROR_CODES as readonly string[]).includes(code);
}

function isRefundErrorCode(code: string): code is RefundErrorCode {
  return (REFUND_ERROR_CODES as readonly string[]).includes(code);
}

/**
 * DB が決まった言葉で断った誤りだけを見分ける（T7-6）。ReturnStoreError か RefundOperationError で、
 * 記号が C-4 か E-2 の表に入る物。表に無い記号（DB の SQLSTATE など）は断りではなく、思いがけない失敗として 500 にする
 */
export function refusalCodeOf(error: unknown): ReturnErrorCode | RefundErrorCode | null {
  if (!(error instanceof ReturnStoreError) && !(error instanceof RefundOperationError)) {
    return null;
  }
  const code: unknown = error.code;
  return typeof code === 'string' && (isReturnErrorCode(code) || isRefundErrorCode(code)) ? code : null;
}

/** 断りの記号を、HTTP・画面の言葉・監査に直す。409 は衝突、ほかは失敗（E-2 の toRefundReply と同じ） */
export function toRefusalReply(code: ReturnErrorCode | RefundErrorCode, detail: string): ReturnReply {
  const { status, body } = isReturnErrorCode(code)
    ? { status: RETURN_ERROR_MESSAGES[code].status, body: { error: RETURN_ERROR_MESSAGES[code].message, code } }
    : { status: REFUND_ERROR_MESSAGES[code].status, body: refundErrorBody(code) };
  return { status, body, audit: { outcome: status === 409 ? 'conflict' : 'failure', detail, metadata: { code } } };
}

/** 受け取りは記録済み（Stripe に頼む前に DB が書いた）なので、E-2 の答えに受け取りの番号を足す */
function withReceipt(reply: RefundReply, receiptId: string): ReturnReply {
  return {
    status: reply.status,
    body: { ...reply.body, receiptId },
    audit: { ...reply.audit, metadata: { ...reply.audit.metadata, receipt_id: receiptId } },
  };
}

export function toReceiveReply(result: ReceiveReturnResult): ReturnReply {
  switch (result.kind) {
    case 'received': {
      // 返金が無い受け取り（相談・なし）は3つとも null。0円で省いた時は返金の番号が null・額が 0・状態が waived（P20）
      const refundId = result.refund?.refundId ?? null;
      const refundAmount = result.refund?.amount ?? null;
      const refundStatus = result.refund?.status ?? null;
      return {
        status: 200,
        body: {
          data: {
            receiptId: result.receiptId,
            returnStatus: result.returnStatus,
            refundId,
            refundAmount,
            refundStatus,
            feeDueAmount: result.feeDueAmount,
            replayed: result.replayed,
          },
        },
        audit: {
          outcome: 'success',
          detail: 'Return received',
          metadata: {
            receipt_id: result.receiptId,
            return_status: result.returnStatus,
            refund_id: refundId,
            refund_amount: refundAmount,
            refund_status: refundStatus,
            fee_due_amount: result.feeDueAmount,
            replayed: result.replayed,
          },
        },
      };
    }
    case 'refused':
      return toRefusalReply(result.code, 'Return receive refused');
    case 'refund_not_accepted':
      // Stripe が断った（422）・答えが分からない（502。Stripe は返金を作ったかもしれない）・E-2 が断った。
      // 言葉と返金の番号は E-2 のまま、画面が開き直した後も同じ二重防止の番号で確かめ直せるよう、受け取りの番号を足す
      return withReceipt(toRefundReply(result.refund), result.receiptId);
  }
}

export function toRefundReturnReply(result: RefundReturnResult): ReturnReply {
  switch (result.kind) {
    case 'refused':
      return toRefusalReply(result.code, 'Return refund refused');
    case 'waived':
      // 0円は返金の記録を作らず Stripe にも頼まない（P20）。お客様への返金のお知らせも無い
      return {
        status: 200,
        body: { data: { refundId: null, amount: 0, status: 'waived', replayed: result.replayed } },
        audit: {
          outcome: 'success',
          detail: 'Refund waived',
          metadata: { refund_id: null, status: 'waived', amount: 0, replayed: result.replayed },
        },
      };
    case 'accepted': {
      // E-2 の返金の窓口と同じ言葉・同じ監査。成功だけ data に入れる（C-3）
      const reply = toRefundReply(result);
      return { ...reply, body: { data: reply.body } };
    }
    case 'stripe_rejected':
    case 'unknown':
      return toRefundReply(result);
  }
}

/**
 * 窓口の失敗のログに出す物。誤りの名前と DB の記号だけにする
 * （DB の文には宛先・氏名・メールが混ざりうるので、出さない）。
 */
export function returnErrorLogFields(error: unknown): string[] {
  const name = error instanceof Error ? error.name : 'UnknownError';
  const code =
    error instanceof ReturnStoreError || error instanceof RefundStoreError || error instanceof RefundOperationError
      ? error.code
      : null;
  return code ? [name, code] : [name];
}

// ---- 守りと監査 ----

export type ReturnAudit = (outcome: AuditOutcome, detail: string, metadata?: Record<string, unknown> | null) => Promise<void>;

/** 監査の書き込み。実行した人・対象・送信元を付ける。メモ・連絡先を含みうる入力は metadata に入れない */
export function createReturnAudit(
  request: Request,
  actorId: string,
  target: { action: string; resource: 'orders' | 'order_returns'; resourceId: string },
): ReturnAudit {
  return (outcome, detail, metadata = null) =>
    logAudit({
      action: target.action,
      actor_id: actorId,
      resource: target.resource,
      resource_id: target.resourceId,
      outcome,
      detail,
      ip: request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
      user_agent: request.headers.get('user-agent') ?? null,
      metadata,
    });
}

export type ReturnWriteGuard = { ok: true; userId: string } | { ok: false; response: Response };

/**
 * 書く窓口の守り（T7-2）: 権限 admin.orders.return（お金の窓口は続けて admin.orders.refund）→ CSRF → 回数の制限
 * （送信元ごと→管理者ごと）。どこかで断られたら、その応答を返し、後の確かめも記録もしない。
 */
export async function guardReturnWrite(
  request: Request,
  options: { rateLimit: RateLimitRule; requireRefundPermission: boolean },
): Promise<ReturnWriteGuard> {
  const authz = await authorizeAdminPermission('admin.orders.return', request);
  if (!authz.ok) {
    return { ok: false, response: authz.response };
  }
  if (options.requireRefundPermission) {
    const refundAuthz = await authorizeAdminPermission('admin.orders.refund', request);
    if (!refundAuthz.ok) {
      return { ok: false, response: refundAuthz.response };
    }
  }

  const { requireCsrfOrDeny } = await import('@/lib/csrfMiddleware');
  const csrfResult = await requireCsrfOrDeny();
  if (csrfResult instanceof Response) {
    return { ok: false, response: csrfResult };
  }

  const ipLimited = await enforceRateLimit({ request, ...options.rateLimit });
  if (ipLimited) {
    return { ok: false, response: ipLimited };
  }
  const actorLimited = await enforceRateLimit({ request, ...options.rateLimit, subject: authz.userId });
  if (actorLimited) {
    return { ok: false, response: actorLimited };
  }
  return { ok: true, userId: authz.userId };
}

/**
 * 実行する人が返金の権限（admin.orders.refund）を持つか（T7-3）。403 だけを「持たない」とする。
 * 401・503・500 は確かめられなかっただけなので、「持たない」と見なさず、その応答をそのまま返す
 */
export async function resolveCanRefund(
  request: Request,
): Promise<{ ok: true; canRefund: boolean } | { ok: false; response: Response }> {
  const authz = await authorizeAdminPermission('admin.orders.refund', request);
  if (authz.ok) {
    return { ok: true, canRefund: true };
  }
  if (authz.response.status === 403) {
    return { ok: true, canRefund: false };
  }
  return { ok: false, response: authz.response };
}

// ---- 失敗の答え ----

/** 入口が答えで返した断り（refused）を、その HTTP と言葉で返し、断りとして監査に残す */
export async function respondToRefusal(
  code: ReturnErrorCode | RefundErrorCode,
  options: { audit: ReturnAudit; refusedDetail: string },
): Promise<Response> {
  const reply = toRefusalReply(code, options.refusedDetail);
  await options.audit(reply.audit.outcome, reply.audit.detail, reply.audit.metadata);
  return NextResponse.json(reply.body, { status: reply.status });
}

/**
 * 書く窓口の catch の中身。決まった言葉で断られた誤りが投げられた時は、答えで返された断りと同じにする。
 * それ以外は 500 で、ログには窓口名つきの文と誤りの名前・DB の記号だけを出し、監査は error にする
 */
export async function respondToReturnError(
  error: unknown,
  options: { audit: ReturnAudit; action: string; refusedDetail: string; failureDetail: string; failureKind: ReturnFailureKind },
): Promise<Response> {
  const code = refusalCodeOf(error);
  if (code) {
    return respondToRefusal(code, { audit: options.audit, refusedDetail: options.refusedDetail });
  }
  console.error(`[${options.action}] ${options.failureDetail}`, ...returnErrorLogFields(error));
  await options.audit('error', options.failureDetail);
  return NextResponse.json(returnFailureBody(options.failureKind), { status: 500 });
}

/** 読む窓口の catch の中身。監査は書かない（読むだけ） */
export async function respondToReturnReadError(
  error: unknown,
  options: { tag: string; failureKind: ReturnFailureKind },
): Promise<Response> {
  const code = refusalCodeOf(error);
  if (code) {
    const reply = toRefusalReply(code, 'Return read refused');
    return NextResponse.json(reply.body, { status: reply.status });
  }
  console.error(options.tag, ...returnErrorLogFields(error));
  return NextResponse.json(returnFailureBody(options.failureKind), { status: 500 });
}
