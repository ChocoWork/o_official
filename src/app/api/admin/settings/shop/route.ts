import { NextResponse } from 'next/server';
import { z } from 'zod';
import { authorizeAdminPermission } from '@/lib/auth/admin-rbac';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { enforceRateLimit } from '@/features/auth/middleware/rateLimit';
import { logAudit } from '@/lib/audit';
import {
  INVALID_REQUEST_BODY,
  REFUND_ERROR_MESSAGES,
  refundErrorBody,
  refundFailureBody,
} from '@/lib/orders/refund/refund-messages';
import { refundErrorLogFields } from '@/lib/orders/refund/refund-route-support';
import {
  RefundOperationError,
  getShopSettings,
  updateShopSettings,
  type ShopSettingsRow,
} from '@/lib/orders/refund/refund-store';
import type { ShopSettings, UpdateShopSettingsRequest } from '@/lib/orders/refund/refund-types';

const bodySchema = z.object({
  autoRefundCancelledOrderPayment: z.boolean(),
  autoCancelAmountMismatch: z.boolean(),
});

const RATE_LIMIT = { endpoint: 'admin:settings:shop-update', limit: 30, windowSeconds: 600 } as const;

type AuditOutcome = 'success' | 'failure' | 'error';

/** 画面に返すのは2つのトグルだけ。切り替えの時刻（refundLedgerStartedAt）は店内の値 */
function toShopSettings(row: ShopSettingsRow): ShopSettings {
  return {
    autoRefundCancelledOrderPayment: row.autoRefundCancelledOrderPayment,
    autoCancelAmountMismatch: row.autoCancelAmountMismatch,
  };
}

/** 保存で変わったトグルの名前（DB の列名）と新しい値だけ。変えた人のメールや時刻は監査に入れない */
function changedToggles(before: ShopSettings, next: UpdateShopSettingsRequest): Record<string, boolean> {
  const changes: Record<string, boolean> = {};
  if (before.autoRefundCancelledOrderPayment.enabled !== next.autoRefundCancelledOrderPayment) {
    changes.auto_refund_cancelled_order_payment = next.autoRefundCancelledOrderPayment;
  }
  if (before.autoCancelAmountMismatch.enabled !== next.autoCancelAmountMismatch) {
    changes.auto_cancel_amount_mismatch = next.autoCancelAmountMismatch;
  }
  return changes;
}

/**
 * ショップの設定を読む（グループ E-2 設計書 9-6）。自動の返金①②のトグルと、最後に変えた人・時刻。
 * 店長だけが読める。読むだけなので CSRF と回数の制限は通さない。
 */
export async function GET(request: Request) {
  const authz = await authorizeAdminPermission('admin.settings.manage', request);
  if (!authz.ok) {
    return authz.response;
  }

  try {
    const store = await createServiceRoleClient();
    const settings = await getShopSettings(store);
    return NextResponse.json({ data: toShopSettings(settings) }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.error('[admin.settings.shop.read] Failed to load settings', ...refundErrorLogFields(error));
    return NextResponse.json(refundFailureBody('settings'), { status: 500 });
  }
}

/**
 * ショップの設定を保存する（グループ E-2 設計書 9-6）。変わったトグルだけ、DB の関数が更新者と時刻を書く。
 * 権限 → CSRF → 回数の制限（送信元ごとと管理者ごと）→ 中身 → 保存の順に確かめる。
 * 監査には、変えたトグルの名前と新しい値だけを残す（保存の前の値を読むのは、そのため）。
 */
export async function PUT(request: Request) {
  const authz = await authorizeAdminPermission('admin.settings.manage', request);
  if (!authz.ok) {
    return authz.response;
  }

  const { requireCsrfOrDeny } = await import('@/lib/csrfMiddleware');
  const csrfResult = await requireCsrfOrDeny();
  if (csrfResult instanceof Response) {
    return csrfResult;
  }

  const ipLimited = await enforceRateLimit({ request, ...RATE_LIMIT });
  if (ipLimited) {
    return ipLimited;
  }
  const actorLimited = await enforceRateLimit({ request, ...RATE_LIMIT, subject: authz.userId });
  if (actorLimited) {
    return actorLimited;
  }

  const audit = (outcome: AuditOutcome, detail: string, metadata: Record<string, unknown> | null = null) =>
    logAudit({
      action: 'admin.settings.shop.update',
      actor_id: authz.userId,
      resource: 'shop_settings',
      resource_id: null,
      outcome,
      detail,
      ip: request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
      user_agent: request.headers.get('user-agent') ?? null,
      metadata,
    });

  const parsedBody = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsedBody.success) {
    await audit('failure', 'Invalid request body');
    return NextResponse.json(INVALID_REQUEST_BODY, { status: 400 });
  }
  const next = parsedBody.data;

  try {
    const store = await createServiceRoleClient();
    const before = await getShopSettings(store);
    const saved = await updateShopSettings(store, { ...next, actorId: authz.userId });
    await audit('success', 'Shop settings saved', { changes: changedToggles(before, next) });
    return NextResponse.json({ data: toShopSettings(saved) });
  } catch (error) {
    // DB の関数が決まった言葉で断った（設定の引数の誤り）。本文は上で確かめ済みなのでふつうは起きない
    if (error instanceof RefundOperationError) {
      await audit('failure', 'Shop settings refused', { code: error.code });
      return NextResponse.json(refundErrorBody(error.code), { status: REFUND_ERROR_MESSAGES[error.code].status });
    }
    console.error('[admin.settings.shop.update] Failed to save settings', ...refundErrorLogFields(error));
    await audit('error', 'Failed to save shop settings');
    return NextResponse.json(refundFailureBody('settings_update'), { status: 500 });
  }
}
