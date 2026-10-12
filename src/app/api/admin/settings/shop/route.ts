import { NextResponse } from 'next/server';
import { z } from 'zod';
import { authorizeAdminPermission } from '@/lib/auth/admin-rbac';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { enforceRateLimit } from '@/features/auth/middleware/rateLimit';
import { logAudit } from '@/lib/audit';
import { INVALID_REQUEST_BODY, refundFailureBody } from '@/lib/orders/refund/refund-messages';
import { getShopSettings, updateShopSettings, type ShopSettingsRow } from '@/lib/orders/refund/refund-store';
import type { ShopSettings, UpdateShopSettingsRequest } from '@/lib/orders/refund/refund-types';
import {
  MAX_FEE_YEN,
  refusalCodeOf,
  returnErrorLogFields,
  toRefusalReply,
  type AuditOutcome,
} from '@/lib/orders/returns/return-route-support';
import { getShopReturnSettings, updateShopReturnSettings } from '@/lib/orders/returns/return-store';
import { RETURN_REASONS, type ShopReturnSettings } from '@/lib/orders/returns/return-types';

/**
 * 返品の欄の本文（Task 4 の return-types.ts の ShopReturnSettingsUpdate と同じ形。型は import せず、ここで zod で持つ。
 * 段1の画面が出す欄を全部、キーは ShopReturnSettings と同じ）。
 * 範囲は DB の関数（Task 2 の admin_update_shop_return_settings。円の3つは Global Constraints の 1,000,000 円まで）と同じなので、
 * 画面（Task 12）が通した値では 400 にならない。知らない欄（段2の欄など）は 400 にする（strict）
 */
const returnSettingsSchema = z
  .object({
    returnAddress: z
      .object({
        name: z.string().trim().min(1).max(200),
        postalCode: z.string().trim().regex(/^[0-9]{3}-?[0-9]{4}$/),
        address: z.string().trim().min(1).max(200),
        phone: z.string().trim().regex(/^[0-9+-]{6,20}$/),
      })
      .strict()
      .nullable(),
    customerPaidMethod: z.enum(['customer_ships', 'shop_label']),
    shopLabelFee: z.number().int().min(0).max(MAX_FEE_YEN),
    noReturnNeededEnabled: z.boolean(),
    windowDays: z.number().int().min(1).max(365).nullable(),
    windowStart: z.enum(['each_item', 'last_item']),
    deliveryBufferDays: z.number().int().min(0).max(14),
    // 理由ごとの返送料の負担と在庫の無い交換。10の理由を1行ずつそろえて送る（出す／ご希望／写真は段2）
    reasons: z
      .array(
        z
          .object({
            reason: z.enum(RETURN_REASONS),
            shippingPayer: z.enum(['shop', 'customer']),
            outOfStockExchange: z.enum(['make', 'decline']),
          })
          .strict(),
      )
      .length(RETURN_REASONS.length)
      .refine((rows) => new Set(rows.map((row) => row.reason)).size === rows.length),
    restockingFeeEnabled: z.boolean(),
    restockingFeePercent: z.number().int().min(0).max(100),
    exchangeFeesEnabled: z.boolean(),
    exchangeFee: z.number().int().min(0).max(MAX_FEE_YEN),
    exchangeShippingFee: z.number().int().min(0).max(MAX_FEE_YEN),
    inspectionEnabled: z.boolean(),
  })
  .strict();

// 今の2つのトグルは必須のまま（画面は返品の欄の保存にも、保存の直前に読み直した値を付ける）。returns は返品の欄の保存の時だけ付く
const bodySchema = z.object({
  autoRefundCancelledOrderPayment: z.boolean(),
  autoCancelAmountMismatch: z.boolean(),
  returns: returnSettingsSchema.optional(),
});

type ReturnSettingsUpdate = z.infer<typeof returnSettingsSchema>;

const RATE_LIMIT = { endpoint: 'admin:settings:shop-update', limit: 30, windowSeconds: 600 } as const;

/** 画面に返すのは2つのトグルと返品の設定。切り替えの時刻（refundLedgerStartedAt）は店内の値 */
function toShopSettings(row: ShopSettingsRow, returns: ShopReturnSettings): ShopSettings & { returns: ShopReturnSettings } {
  return {
    autoRefundCancelledOrderPayment: row.autoRefundCancelledOrderPayment,
    autoCancelAmountMismatch: row.autoCancelAmountMismatch,
    returns,
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

function sameReturnAddress(next: ReturnSettingsUpdate['returnAddress'], current: ShopReturnSettings['returnAddress']): boolean {
  if (next === null || current === null) {
    return next === current;
  }
  return next.name === current.name
    && next.postalCode === current.postalCode
    && next.address === current.address
    && next.phone === current.phone;
}

function sameReasons(next: ReturnSettingsUpdate['reasons'], current: ShopReturnSettings['reasons']): boolean {
  return next.every((entry) => {
    const row = current.find((candidate) => candidate.reason === entry.reason);
    return row !== undefined && row.shippingPayer === entry.shippingPayer && row.outOfStockExchange === entry.outOfStockExchange;
  });
}

/**
 * 保存で変わった返品の欄のまとまりの名前だけ（Task 12 の約束のとおりの対応）。値は残さない
 * （返送先は住所・電話を含み、監査に宛先・氏名・住所を入れない決まりのため）
 */
function changedReturnGroups(before: ShopReturnSettings, next: ReturnSettingsUpdate): string[] {
  const groups: string[] = [];
  if (
    !sameReturnAddress(next.returnAddress, before.returnAddress)
    || next.customerPaidMethod !== before.customerPaidMethod
    || next.shopLabelFee !== before.shopLabelFee
    || next.noReturnNeededEnabled !== before.noReturnNeededEnabled
  ) {
    groups.push('shipping');
  }
  if (
    next.windowDays !== before.windowDays
    || next.windowStart !== before.windowStart
    || next.deliveryBufferDays !== before.deliveryBufferDays
  ) {
    groups.push('window');
  }
  if (!sameReasons(next.reasons, before.reasons)) {
    groups.push('reasons');
  }
  if (
    next.restockingFeeEnabled !== before.restockingFeeEnabled
    || next.restockingFeePercent !== before.restockingFeePercent
    || next.exchangeFeesEnabled !== before.exchangeFeesEnabled
    || next.exchangeFee !== before.exchangeFee
    || next.exchangeShippingFee !== before.exchangeShippingFee
  ) {
    groups.push('fees');
  }
  if (next.inspectionEnabled !== before.inspectionEnabled) {
    groups.push('receiving');
  }
  return groups;
}

/**
 * ショップの設定を読む（グループ E-2 設計書 9-6、グループ E-3 設計書 8-3）。自動の返金①②のトグルと、返品の欄の設定
 * （最後に変えた人・時刻つき）。店長だけが読める。読むだけなので CSRF と回数の制限は通さない。答えには返品の設定を必ず入れる。
 */
export async function GET(request: Request) {
  const authz = await authorizeAdminPermission('admin.settings.manage', request);
  if (!authz.ok) {
    return authz.response;
  }

  try {
    const store = await createServiceRoleClient();
    const [settings, returns] = await Promise.all([getShopSettings(store), getShopReturnSettings(store)]);
    return NextResponse.json({ data: toShopSettings(settings, returns) }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.error('[admin.settings.shop.read] Failed to load settings', ...returnErrorLogFields(error));
    return NextResponse.json(refundFailureBody('settings'), { status: 500 });
  }
}

/**
 * ショップの設定を保存する（グループ E-2 設計書 9-6、グループ E-3 設計書 8-3）。変わったトグルだけ、DB の関数が更新者と時刻を書く。
 * 権限 → CSRF → 回数の制限（送信元ごとと管理者ごと）→ 中身 → 保存の順に確かめる。
 * 返品の欄（returns）が付いた時は、返品の欄 → トグルの順に別々の取引で保存する。返品の欄を DB が断れば、トグルは保存しない。
 * returns の無い保存（自動の返金のトグルだけ）は、返品の設定に触らない。答えには、保存した後の返品の設定を必ず入れる。
 * 監査には、変えたトグルの名前と新しい値、変わった返品の欄のまとまりの名前だけを残す（保存の前の値を読むのは、そのため）。
 * 返品の欄を保存できた後にトグルの保存が失敗した時は、その失敗の監査にも変わったまとまりを付ける（返品の設定はもう変わっている）。
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
  const { returns, ...next } = parsedBody.data;

  // 返品の欄を保存できた後にトグルの保存が落ちても、変わったまとまりを監査に残す（返品の設定はもう変わっているため）
  let savedReturnGroups: string[] | null = null;
  try {
    const store = await createServiceRoleClient();
    const [beforeToggles, beforeReturns] = await Promise.all([getShopSettings(store), getShopReturnSettings(store)]);
    // 返品の欄を先に保存する（DB が断る見込みが高いのは、こちら）。断られたらトグルは保存しない
    let savedReturns = beforeReturns;
    if (returns) {
      savedReturns = await updateShopReturnSettings(store, { settings: returns, actorId: authz.userId });
      savedReturnGroups = changedReturnGroups(beforeReturns, returns);
    }
    const savedToggles = await updateShopSettings(store, { ...next, actorId: authz.userId });
    await audit('success', 'Shop settings saved', {
      changes: changedToggles(beforeToggles, next),
      ...(savedReturnGroups ? { returns_changed_groups: savedReturnGroups } : {}),
    });
    return NextResponse.json({ data: toShopSettings(savedToggles, savedReturns) });
  } catch (error) {
    const savedGroupsAudit = savedReturnGroups ? { returns_changed_groups: savedReturnGroups } : null;
    // DB の関数が決まった言葉で断った（設定の引数の誤り）。本文は上で確かめ済みなのでふつうは起きない
    const code = refusalCodeOf(error);
    if (code) {
      const reply = toRefusalReply(code, 'Shop settings refused');
      await audit(reply.audit.outcome, reply.audit.detail, { ...reply.audit.metadata, ...(savedGroupsAudit ?? {}) });
      return NextResponse.json(reply.body, { status: reply.status });
    }
    console.error('[admin.settings.shop.update] Failed to save settings', ...returnErrorLogFields(error));
    await audit('error', 'Failed to save shop settings', savedGroupsAudit);
    return NextResponse.json(refundFailureBody('settings_update'), { status: 500 });
  }
}
