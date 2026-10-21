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
import { RETURN_REASONS, type ShopReturnSettings, type ShopReturnSettingsUpdate } from '@/lib/orders/returns/return-types';
import { isDeliveryTrackingKeyConfigured } from '@/lib/orders/tracking/delivery-config';
import { deliveryErrorReply } from '@/lib/orders/tracking/delivery-route-support';
import { DeliveryOperationError, DeliveryStoreError, getDeliveryTrackingSettings, setDeliveryTracking } from '@/lib/orders/tracking/delivery-store';
import type { DeliveryTrackingSettings } from '@/lib/orders/tracking/delivery-types';

/**
 * 返品の欄の本文（Task 4 の return-types.ts の ShopReturnSettingsUpdate と同じ形。段1の欄は必須、段2の欄は任意）。
 * 段2の欄（申し込み・種類・注意書き、理由の行の 出す／ご希望／写真／案内の文）は、渡さなければ DB が今の値のままにする
 * （段1の設定の画面は Task 13 まで段1の欄だけを送る。段2の画面はいつも全部を送る）。
 * 範囲は DB の関数（admin_update_shop_return_settings。円の3つは Global Constraints の 1,000,000 円まで、注意書き2000字、写真の案内の文500字）と
 * 同じ（文は前後の空白を除いて数える。P14）。知らない欄は 400 にする（strict）。
 * 保存の前後を比べる部品（changedReturnGroups）は ShopReturnSettingsUpdate で受けるので、この形が型とずれたら、型の誤りで気づく
 */
const returnSettingsSchema = z
  .object({
    // 申し込み（グループ E-3 段2）。任意。注意書きは前後の空白を除いて2000字まで（空は空）
    requestsEnabled: z.boolean().optional(),
    requestTypes: z.enum(['returns_and_cancellations', 'returns_only', 'cancellations_only']).optional(),
    noticeText: z.string().trim().max(2000).optional(),
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
    // 理由ごとの設定。10の理由を1行ずつそろえて送る。段2の欄（出す／ご希望／写真／案内の文）は任意。「不明」はお客様に出さない（「出す」を真にすると DB も断る）
    reasons: z
      .array(
        z
          .object({
            reason: z.enum(RETURN_REASONS),
            shown: z.boolean().optional(),
            resolutions: z.enum(['refund_and_exchange', 'exchange_only', 'refund_only']).optional(),
            shippingPayer: z.enum(['shop', 'customer']),
            outOfStockExchange: z.enum(['make', 'decline']),
            photo: z.enum(['none', 'optional', 'required']).optional(),
            photoInstructions: z.string().trim().max(500).optional(),
          })
          .strict(),
      )
      .length(RETURN_REASONS.length)
      .refine((rows) => new Set(rows.map((row) => row.reason)).size === rows.length)
      .refine((rows) => rows.every((row) => row.reason !== 'unknown' || row.shown !== true)),
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
  deliveryTracking: z.object({ enabled: z.boolean() }).strict().optional(),
}).strict();

// 保存の前後を比べる部品は、画面が送る型（Task 4）で受ける。zod の形がこの型とずれたら、呼ぶ所（changedReturnGroups(…, returns)）が型の誤りになる
type ReturnSettingsUpdate = ShopReturnSettingsUpdate;

const RATE_LIMIT = { endpoint: 'admin:settings:shop-update', limit: 30, windowSeconds: 600 } as const;

/** 画面に返すのは2つのトグルと返品の設定。切り替えの時刻（refundLedgerStartedAt）は店内の値 */
function toShopSettings(
  row: ShopSettingsRow, returns: ShopReturnSettings, delivery: Omit<DeliveryTrackingSettings, 'keyConfigured'>,
): ShopSettings & { returns: ShopReturnSettings; deliveryTracking: DeliveryTrackingSettings } {
  return {
    autoRefundCancelledOrderPayment: row.autoRefundCancelledOrderPayment,
    autoCancelAmountMismatch: row.autoCancelAmountMismatch,
    returns,
    deliveryTracking: {
      enabled: delivery.enabled, updatedAt: delivery.updatedAt, updatedByEmail: delivery.updatedByEmail,
      backfillCount: delivery.backfillCount, keyConfigured: isDeliveryTrackingKeyConfigured(process.env),
    },
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
    // 段2の欄は渡さなければ今の値のまま（undefined）なので、渡した欄だけを比べる
    return row !== undefined
      && (entry.shown === undefined || row.shown === entry.shown)
      && (entry.resolutions === undefined || row.resolutions === entry.resolutions)
      && row.shippingPayer === entry.shippingPayer
      && row.outOfStockExchange === entry.outOfStockExchange
      && (entry.photo === undefined || row.photo === entry.photo)
      && (entry.photoInstructions === undefined || row.photoInstructions === entry.photoInstructions);
  });
}

/**
 * 保存で変わった返品の欄のまとまりの名前だけ（Task 12 の約束のとおりの対応）。値は残さない
 * （返送先は住所・電話を含み、監査に宛先・氏名・住所を入れない決まりのため）
 */
function changedReturnGroups(before: ShopReturnSettings, next: ReturnSettingsUpdate): string[] {
  const groups: string[] = [];
  // 申し込み（受付・種類・注意書き）。渡さなかった欄（undefined）は今の値のままなので、変わったとは数えない。
  // 画面のまとまり「申し込み」は段1のまとまりの前（グループ E-3 段2）
  if (
    (next.requestsEnabled !== undefined && next.requestsEnabled !== before.requestsEnabled)
    || (next.requestTypes !== undefined && next.requestTypes !== before.requestTypes)
    || (next.noticeText !== undefined && next.noticeText !== before.noticeText)
  ) {
    groups.push('requests');
  }
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
    const [settings, returns, delivery] = await Promise.all([getShopSettings(store), getShopReturnSettings(store), getDeliveryTrackingSettings(store)]);
    return NextResponse.json({ data: toShopSettings(settings, returns, delivery) }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.error('[admin.settings.shop.read] Failed to load settings', ...returnErrorLogFields(error),
      ...(error instanceof DeliveryStoreError && error.code ? [error.code] : []));
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
  const { returns, deliveryTracking, ...next } = parsedBody.data;
  // P6/P24: ON の鍵確認はすべての保存より先。鍵が失われた後も OFF は許す。
  if (deliveryTracking?.enabled && !isDeliveryTrackingKeyConfigured(process.env)) {
    const reply = deliveryErrorReply(new DeliveryOperationError('DELIVERY_TRACKING_KEY_MISSING'));
    await audit('conflict', 'Shop settings refused');
    return NextResponse.json(reply.body, { status: reply.status });
  }

  // 返品の欄を保存できた後にトグルの保存が落ちても、変わったまとまりを監査に残す（返品の設定はもう変わっているため）
  let savedReturnGroups: string[] | null = null;
  let savedToggleChanges: Record<string, boolean> | null = null;
  let savedDelivery: { delivery_tracking_enabled: boolean; backfilled_count: number } | null = null;
  try {
    const store = await createServiceRoleClient();
    const [beforeToggles, beforeReturns, beforeDelivery] = await Promise.all([
      getShopSettings(store), getShopReturnSettings(store), getDeliveryTrackingSettings(store),
    ]);
    // 返品の欄を先に保存する（DB が断る見込みが高いのは、こちら）。断られたらトグルは保存しない
    let savedReturns = beforeReturns;
    if (returns) {
      savedReturns = await updateShopReturnSettings(store, { settings: returns, actorId: authz.userId });
      savedReturnGroups = changedReturnGroups(beforeReturns, returns);
    }
    const savedToggles = await updateShopSettings(store, { ...next, actorId: authz.userId });
    savedToggleChanges = changedToggles(beforeToggles, next);
    let delivery = beforeDelivery;
    let backfilledCount: number | undefined;
    if (deliveryTracking) {
      const result = await setDeliveryTracking(store, { enabled: deliveryTracking.enabled, actorId: authz.userId });
      backfilledCount = result.backfilledCount;
      savedDelivery = { delivery_tracking_enabled: result.enabled, backfilled_count: result.backfilledCount };
      // 更新者のメールと、保存後時点の正確な見込み件数は管理用の読取で取得する。
      delivery = await getDeliveryTrackingSettings(store);
    }
    await audit('success', 'Shop settings saved', {
      changes: savedToggleChanges,
      ...(savedReturnGroups ? { returns_changed_groups: savedReturnGroups } : {}),
      ...savedDelivery,
    });
    return NextResponse.json({ data: {
      ...toShopSettings(savedToggles, savedReturns, delivery),
      ...(backfilledCount === undefined ? {} : { backfilledCount }),
    } }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const savedGroupsAudit = savedReturnGroups || savedToggleChanges || savedDelivery ? {
      ...(savedReturnGroups ? { returns_changed_groups: savedReturnGroups } : {}),
      ...(savedToggleChanges ? { changes: savedToggleChanges } : {}),
      ...savedDelivery,
    } : null;
    if (error instanceof DeliveryOperationError) {
      const reply = deliveryErrorReply(error);
      await audit(reply.status === 409 ? 'conflict' : 'failure', 'Shop settings refused', savedGroupsAudit);
      return NextResponse.json(reply.body, { status: reply.status });
    }
    // DB の関数が決まった言葉で断った（設定の引数の誤り）。本文は上で確かめ済みなのでふつうは起きない
    const code = refusalCodeOf(error);
    if (code) {
      const reply = toRefusalReply(code, 'Shop settings refused');
      await audit(reply.audit.outcome, reply.audit.detail, { ...reply.audit.metadata, ...(savedGroupsAudit ?? {}) });
      return NextResponse.json(reply.body, { status: reply.status });
    }
    console.error('[admin.settings.shop.update] Failed to save settings', ...returnErrorLogFields(error),
      ...(error instanceof DeliveryStoreError && error.code ? [error.code] : []));
    await audit('error', 'Failed to save shop settings', savedGroupsAudit);
    return NextResponse.json(refundFailureBody('settings_update'), { status: 500 });
  }
}
