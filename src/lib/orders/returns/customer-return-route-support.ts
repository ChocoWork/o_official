import { NextResponse } from 'next/server';
import { z } from 'zod';
import { enforceRateLimit } from '@/features/auth/middleware/rateLimit';
import { denyIfCsrfInvalid } from '@/features/cart/services/shopping-context';
import { logAudit } from '@/lib/audit';
import { authenticateRequest, authFailureResponse } from '@/lib/auth/authenticate';
import {
  CUSTOMER_RETURN_ERROR_MESSAGES,
  CUSTOMER_RETURN_FAILURE_MESSAGE,
  isCustomerReturnErrorCode,
  type CustomerReturnErrorCode,
} from '@/lib/orders/returns/customer-return-messages';
import { CustomerOrderNotFoundError } from '@/lib/orders/returns/customer-return-store';
import { ReturnStoreError } from '@/lib/orders/returns/return-store';

/**
 * お客様の返品・交換とキャンセルの申し込みの窓口が共有する部品（グループ E-3 段2 Task 7、決め事 T7-1）。
 * 段1の管理画面の窓口（return-route-support.ts）と同じ考えで、守りの順・断りの言葉・監査・ログを1か所に持ち、
 * 窓口がずれないようにする。管理者の権限の部品（admin-rbac）は import しない。サーバーだけで使う。
 * 監査の鍵は maskAuditEvent に伏せられない名前にし（number・card・pan・token などを含めない）、
 * 宛先・氏名・住所・メール・詳しい内容・ご連絡事項・写真の場所と署名つきのリンクは入れない。
 */

// ---- 回数の制限（計画の冒頭 Global Constraints。送信元ごとと、お客様ごとの2つに同じ回数を使う） ----

export type RateLimitRule = { readonly endpoint: string; readonly limit: number; readonly windowSeconds: number };

export const CUSTOMER_RETURN_RATE_LIMITS = {
  request: { endpoint: 'account:returns:request', limit: 10, windowSeconds: 3600 },
  photoUpload: { endpoint: 'account:returns:photo-upload', limit: 30, windowSeconds: 3600 },
  cancelRequest: { endpoint: 'account:cancel-requests:create', limit: 10, windowSeconds: 3600 },
} as const satisfies Record<string, RateLimitRule>;

// ---- 答えの作り方 ----

const NO_STORE_HEADERS = { 'Cache-Control': 'no-store' };

/** お客様の窓口の答え。お客様ごとの答え・署名つきの送り先を含むので、いつも no-store */
export function customerJson(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: NO_STORE_HEADERS });
}

/** 持ち主でない・無い・お客様に隠す状態の注文。今の注文の窓口と同じ文（持ち主でない注文の有無を漏らさない） */
export function orderNotFoundResponse(): NextResponse {
  return customerJson({ error: 'Order not found' }, 404);
}

/** 本文の形の誤り。詳しい内容などを含みうる検証の詳細は返さず、お客様の言葉だけを返す */
export function invalidArgumentResponse(): NextResponse {
  const { status, message } = CUSTOMER_RETURN_ERROR_MESSAGES.RETURN_ARGUMENT_INVALID;
  return customerJson({ error: message, code: 'RETURN_ARGUMENT_INVALID' }, status);
}

/** 写真が合わない時の 400。画面が、どの写真を外すかを決められるよう、合わない送り先の番号を返す（DB が断った時は空） */
export function photoInvalidResponse(invalidPhotoUploadIds: string[]): NextResponse {
  const { status, message } = CUSTOMER_RETURN_ERROR_MESSAGES.RETURN_PHOTO_INVALID;
  return customerJson({ error: message, code: 'RETURN_PHOTO_INVALID', invalidPhotoUploadIds }, status);
}

// ---- 本文・注文の番号の部品 ----

const ORDER_ID_SCHEMA = z.string().uuid();

/** 注文の番号。uuid でない文字は、どの注文にも当たらないので、注文が無いのと同じに扱う（null） */
export function parseOrderId(raw: string): string | null {
  const parsed = ORDER_ID_SCHEMA.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** 詳しい内容・ご連絡事項の上限（DB の customer_note の CHECK と同じ） */
const CUSTOMER_NOTE_MAX_LENGTH = 300;

/** 前後の空白を除き、空・空白だけ・省略は持たない（null）。DB の parse_customer_return_lines と同じ決まり */
export const customerNoteSchema = z
  .string()
  .trim()
  .max(CUSTOMER_NOTE_MAX_LENGTH)
  .nullish()
  .transform((value) => value || null);

// ---- 守りと監査 ----

export type CustomerGuard = { ok: true; customerId: string } | { ok: false; response: Response };

/** 読む窓口の守り。ログインの確かめだけ（CSRF も回数の制限も通さない）。お客様の番号はトークンの claims.sub だけから決める */
export async function guardCustomerRead(request: Request): Promise<CustomerGuard> {
  const auth = await authenticateRequest(request);
  if (!auth.ok) {
    return { ok: false, response: authFailureResponse(auth.reason, NO_STORE_HEADERS) };
  }
  return { ok: true, customerId: auth.claims.sub };
}

/**
 * 書く窓口の守り（決め事 T7-2）: ログイン → CSRF → 回数の制限（送信元ごと→お客様ごと）。どこかで断られたら、
 * その応答を返し、後の確かめも記録もしない。ログイン前の要求が、送信元ごとの枠を使い切れないように、ログインを先に確かめる
 */
export async function guardCustomerWrite(request: Request, rule: RateLimitRule): Promise<CustomerGuard> {
  const guard = await guardCustomerRead(request);
  if (!guard.ok) {
    return guard;
  }
  const csrfDenied = await denyIfCsrfInvalid();
  if (csrfDenied) {
    return { ok: false, response: csrfDenied };
  }
  const ipLimited = await enforceRateLimit({ request, ...rule });
  if (ipLimited) {
    return { ok: false, response: ipLimited };
  }
  const customerLimited = await enforceRateLimit({ request, ...rule, subject: guard.customerId });
  if (customerLimited) {
    return { ok: false, response: customerLimited };
  }
  return guard;
}

export type CustomerAuditOutcome = 'success' | 'failure' | 'conflict' | 'error';

export type CustomerAudit = (
  outcome: CustomerAuditOutcome,
  detail: string,
  metadata?: Record<string, unknown> | null,
) => Promise<void>;

/** 監査の書き込み。実行したお客様・注文・送信元を付ける。メールアドレスは付けず、入力の中身は metadata に入れない */
export function createCustomerAudit(
  request: Request,
  customerId: string,
  target: { action: string; orderId: string },
): CustomerAudit {
  return (outcome, detail, metadata = null) =>
    logAudit({
      action: target.action,
      actor_id: customerId,
      resource: 'orders',
      resource_id: target.orderId,
      outcome,
      detail,
      ip: request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
      user_agent: request.headers.get('user-agent') ?? null,
      metadata,
    });
}

// ---- 失敗の答え ----

/**
 * DB が決まった言葉で断った誤りのうち、お客様の言葉がある記号だけを見分ける（記号の見分けは Task 4 の isCustomerReturnErrorCode）。
 * お客様の欄が無い記号（管理画面だけで出る記号や、E-2 の返金の記号）は、お客様に出せないので断りとして扱わず、想定外の失敗（500）にする
 */
export function customerRefusalCodeOf(error: unknown): CustomerReturnErrorCode | null {
  if (!(error instanceof ReturnStoreError)) {
    return null;
  }
  const code: string = error.code;
  return isCustomerReturnErrorCode(code) ? code : null;
}

/** 注文が無い・持ち主でない・隠す状態。DB の ORDER_NOT_FOUND を、store は CustomerOrderNotFoundError にする（E-2 の記号 order_not_found の形で届いても同じに扱う） */
function isOrderNotFound(error: unknown): boolean {
  return (
    error instanceof CustomerOrderNotFoundError || (error instanceof ReturnStoreError && error.code === 'order_not_found')
  );
}

/** 窓口の失敗のログに出す物。誤りの名前と記号（DB の記号、置き場の storage_unavailable など）だけにする（DB の文・署名つきの送り先・宛先を出さない） */
function errorLogFields(error: unknown): string[] {
  const name = error instanceof Error ? error.name : 'UnknownError';
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return typeof code === 'string' ? [name, code] : [name];
}

/**
 * 窓口の catch の中身。注文が無ければ 404、お客様の言葉がある断りはその HTTP と言葉、それ以外は 500 の言葉。
 * 500 のログには窓口名つきの文と誤りの名前・DB の記号だけを出し、監査（あれば）は error にする。
 */
export async function respondToCustomerReturnError(
  error: unknown,
  options: {
    /** 監査を書く窓口の書き込み。読む窓口と写真の送り先の窓口は null（書かない） */
    audit: CustomerAudit | null;
    /** ログの頭に付ける窓口名 */
    tag: string;
    /** お客様の言葉で断った時の監査の文 */
    refusedDetail: string;
    /** 想定外の失敗の時の監査・ログの文 */
    failureDetail: string;
  },
): Promise<NextResponse> {
  if (isOrderNotFound(error)) {
    await options.audit?.('failure', 'Order not found');
    return orderNotFoundResponse();
  }
  const code = customerRefusalCodeOf(error);
  if (code) {
    const { status, message } = CUSTOMER_RETURN_ERROR_MESSAGES[code];
    await options.audit?.(status === 409 ? 'conflict' : 'failure', options.refusedDetail, { code });
    // 写真の断りは、窓口が DB の前に断る時と同じ形（合わない送り先の番号つき）にそろえる。DB が断った時はどの写真か分からないので空
    return code === 'RETURN_PHOTO_INVALID' ? photoInvalidResponse([]) : customerJson({ error: message, code }, status);
  }
  console.error(`[${options.tag}] ${options.failureDetail}`, ...errorLogFields(error));
  await options.audit?.('error', options.failureDetail);
  return customerJson({ error: CUSTOMER_RETURN_FAILURE_MESSAGE }, 500);
}
