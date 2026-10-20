import { createServiceRoleClient } from '@/lib/supabase/server';
import {
  CUSTOMER_RETURN_RATE_LIMITS,
  customerJson,
  guardCustomerWrite,
  orderNotFoundResponse,
  parseOrderId,
  respondToCustomerReturnError,
} from '@/lib/orders/returns/customer-return-route-support';
import { issueReturnPhotoUpload } from '@/lib/orders/returns/return-photo-storage';

/**
 * 申し込みの写真の送り先を1つ出す（グループ E-3 段2 設計書 4-9）。画面が、選んだ写真を縮めた後に1枚ずつ呼ぶ。
 * ログイン → CSRF → 回数の制限（送信元ごととお客様ごと。1時間に30回）→ 注文の番号 → 送り先を出す、の順。
 * 持ち主・受付・1日に出せる数（60）は DB の関数が確かめる。本文は読まない（中身なし）。
 * 答えの signedUrl は鍵を含む（上書きできない形で2時間だけ使える）ので、ログ・監査・誤りの答えに出さない。
 * 監査は書かない: 送り先の表（order_return_photo_uploads）が、お客様・注文・時刻を記録している。
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const guard = await guardCustomerWrite(request, CUSTOMER_RETURN_RATE_LIMITS.photoUpload);
  if (!guard.ok) {
    return guard.response;
  }
  const orderId = parseOrderId((await params).id);
  if (!orderId) {
    return orderNotFoundResponse();
  }

  try {
    const client = await createServiceRoleClient();
    const upload = await issueReturnPhotoUpload(client, { orderId, customerId: guard.customerId });
    return customerJson({ data: { uploadId: upload.uploadId, signedUrl: upload.signedUrl } });
  } catch (error) {
    return respondToCustomerReturnError(error, {
      audit: null,
      tag: 'account.orders.return.photo-upload',
      refusedDetail: 'Return photo upload refused',
      failureDetail: 'Failed to issue return photo upload',
    });
  }
}
