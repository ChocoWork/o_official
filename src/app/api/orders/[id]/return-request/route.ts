import { z } from 'zod';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { scheduleOrderEmailDelivery } from '@/lib/orders/email/order-email-schedule';
import {
  CUSTOMER_RETURN_RATE_LIMITS,
  createCustomerAudit,
  customerJson,
  customerNoteSchema,
  guardCustomerRead,
  guardCustomerWrite,
  invalidArgumentResponse,
  orderNotFoundResponse,
  parseOrderId,
  photoInvalidResponse,
  respondToCustomerReturnError,
} from '@/lib/orders/returns/customer-return-route-support';
import { loadCustomerReturnRequestMaterials, requestCustomerReturn } from '@/lib/orders/returns/customer-return-store';
import { formatReturnNumber } from '@/lib/orders/returns/return-messages';
import { verifyReturnPhotoUploads } from '@/lib/orders/returns/return-photo-storage';
import { RETURN_REASONS } from '@/lib/orders/returns/return-types';

const ACTION = 'account.orders.return.request';

const lineSchema = z.object({
  fulfillmentId: z.string().uuid(),
  orderItemId: z.string().uuid(),
  quantity: z.number().int().min(1).max(999),
  // unknown（不明）はお店が昔の返品に付ける理由で、お客様には出さない（Global Constraints）
  reason: z.enum(RETURN_REASONS).exclude(['unknown']),
  customerNote: customerNoteSchema,
  requestedResolution: z.enum(['refund', 'exchange']),
  requestedExchangeVariantId: z.number().int().positive().nullish().transform((value) => value ?? null),
  // 写真の種類と大きさは本文に持たない。サーバーが置き場の中身を読んで決める
  photoUploadIds: z.array(z.string().uuid()).max(5),
});

// 1回の申し込みに付けられる写真は、1日に出せる送り先の数（DB の customer_create_return_photo_upload の上限 60）まで。
// それより多い本文は、置き場の確かめ（送り先の表への問い合わせと読み書き）が膨らむ前に断る
const MAX_PHOTO_UPLOADS_PER_REQUEST = 60;

// 数・期限・理由・ご希望・交換の色とサイズ・写真の数と必須は DB が確かめる（ここでは形だけ）
const bodySchema = z
  .object({
    requestKey: z.string().uuid(),
    lines: z.array(lineSchema).min(1).max(100),
  })
  .refine((body) => new Set(body.lines.flatMap((line) => line.photoUploadIds)).size <= MAX_PHOTO_UPLOADS_PER_REQUEST);

/**
 * 返品・交換の申し込みの材料（グループ E-3 段2 設計書 8-3）。申し込みの画面を開いた時に読む。
 * ログインしたお客様の注文だけが読める（持ち主・お客様に隠す状態は DB の関数が確かめる）。読むだけなので CSRF と回数の制限は通さない。
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const guard = await guardCustomerRead(request);
  if (!guard.ok) {
    return guard.response;
  }
  const orderId = parseOrderId((await params).id);
  if (!orderId) {
    return orderNotFoundResponse();
  }

  try {
    const store = await createServiceRoleClient();
    const materials = await loadCustomerReturnRequestMaterials(store, { orderId, customerId: guard.customerId });
    if (!materials) {
      return orderNotFoundResponse();
    }
    return customerJson({ data: materials });
  } catch (error) {
    return respondToCustomerReturnError(error, {
      audit: null,
      tag: 'account.orders.return.materials',
      refusedDetail: 'Return materials refused',
      failureDetail: 'Failed to load return materials',
    });
  }
}

/**
 * 返品・交換を申し込む。ログイン → CSRF → 回数の制限（送信元ごととお客様ごと）→ 注文の番号 → 中身 → 写真の確かめ → DB の関数の順に確かめる。
 * 写真は申し込みの DB の関数の前に確かめる（種類・大きさ・撮影の情報を読み、情報が付いていれば消した写しに置き直す）。
 * 合わない写真がある時だけ、読む関数で持ち主を確かめ、注文が無ければほかの道と同じ 404 にする。
 * お客様の番号はトークンの claims.sub だけから決め、本文のどんな項目も使わない。同じ requestKey の送り直しは前の返品を返す（replayed）。
 * 申し込みを新しく書いた時だけ、返事の後にメールの送る処理を動かす。監査に詳しい内容・写真の場所は入れない。
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const guard = await guardCustomerWrite(request, CUSTOMER_RETURN_RATE_LIMITS.request);
  if (!guard.ok) {
    return guard.response;
  }
  const orderId = parseOrderId((await params).id);
  if (!orderId) {
    return orderNotFoundResponse();
  }
  const audit = createCustomerAudit(request, guard.customerId, { action: ACTION, orderId });

  const parsedBody = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsedBody.success) {
    // 入力値や検証の詳細は詳しい内容などを含みうるので、固定の文だけを監査に残す
    await audit('failure', 'Invalid request body');
    return invalidArgumentResponse();
  }
  const { requestKey, lines } = parsedBody.data;
  const photoCount = lines.reduce((total, line) => total + line.photoUploadIds.length, 0);

  try {
    const store = await createServiceRoleClient();

    // 同じ送り先を2つの行に付けた本文は、確かめは1回で済ませ、2回使うことは DB（Task 2 の parse_customer_return_lines）が RETURN_PHOTO_INVALID で断る（窓口の答えは invalidPhotoUploadIds が空の 400）
    const uploadIds = [...new Set(lines.flatMap((line) => line.photoUploadIds))];
    const rejectPhotos = async (invalidUploadIds: string[]) => {
      // 送り先の表は注文とお客様で絞って読むので、持ち主でない・無い・お客様に隠す状態の注文では、どの写真も「合わない」になる。
      // その時は写真の断りにせず、ほかの道と同じ 404 にする（注文の有無を漏らさない。持ち主の確かめは DB の関数がする）
      const materials = await loadCustomerReturnRequestMaterials(store, { orderId, customerId: guard.customerId });
      if (!materials) {
        await audit('failure', 'Order not found');
        return orderNotFoundResponse();
      }
      await audit('failure', 'Return photos invalid', { code: 'RETURN_PHOTO_INVALID', invalid_photo_count: invalidUploadIds.length });
      return photoInvalidResponse(invalidUploadIds);
    };

    let photos: Record<string, { contentType: 'image/jpeg' | 'image/png'; sizeBytes: number }> = {};
    if (uploadIds.length > 0) {
      const verified = await verifyReturnPhotoUploads(store, { orderId, customerId: guard.customerId, uploadIds });
      if (!verified.ok) {
        return await rejectPhotos(verified.invalidUploadIds);
      }
      // 確かめた結果に、渡した送り先が1つでも欠けていたら、その写真は合わない物として断る（DB に推測した種類・大きさを渡さない）
      const missing = uploadIds.filter((uploadId) => !verified.photos[uploadId]);
      if (missing.length > 0) {
        return await rejectPhotos(missing);
      }
      photos = verified.photos;
    }

    const result = await requestCustomerReturn(store, {
      orderId,
      customerId: guard.customerId,
      requestKey,
      lines: lines.map(({ photoUploadIds, ...line }) => ({
        ...line,
        photos: photoUploadIds.map((uploadId) => ({ uploadId, ...photos[uploadId] })),
      })),
    });
    // 何件目かの鍵に number を含めない（maskAuditEvent が number を含む鍵を伏せるため）
    await audit('success', 'Return requested', {
      return_id: result.returnId,
      sequence: result.number,
      line_count: lines.length,
      photo_count: photoCount,
      replayed: result.replayed,
    });
    // 受付と店への知らせのメールの行は DB の関数が同じ取引で書いた。新しく書いた時だけ、返事の後に送る
    // （送り直しの時は前の呼び出しが動かした。動かせていなくても毎分の定期処理が送る）
    if (!result.replayed) {
      scheduleOrderEmailDelivery();
    }
    return customerJson({
      data: {
        returnId: result.returnId,
        number: result.number,
        label: formatReturnNumber(orderId, result.number),
        replayed: result.replayed,
      },
    });
  } catch (error) {
    return respondToCustomerReturnError(error, {
      audit,
      tag: ACTION,
      refusedDetail: 'Return request refused',
      failureDetail: 'Failed to request return',
    });
  }
}
