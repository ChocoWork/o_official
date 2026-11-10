/**
 * お客様の返品の申し込みの返金の見込み（POST /api/orders/[id]/return-request/estimate）。
 *
 * @packageDocumentation
 * @impl FREQ-642-REQ-01
 * @design DD-ADMIN-022
 * @remarks 読むだけ（何も書かない）。注文の持ち主の確かめは、申し込みの材料を読む窓口（GET）と同じ。
 *   選んだ行が全部届き、今すぐ返金し、店長が額を変えない時の、受け取りの返金の額を出す。交換だけならお金が動かない。
 */
import { z } from 'zod';
import { createServiceRoleClient } from '@/lib/supabase/server';
import {
  customerJson,
  guardCustomerRead,
  invalidArgumentResponse,
  orderNotFoundResponse,
  parseOrderId,
  respondToCustomerReturnError,
} from '@/lib/orders/returns/customer-return-route-support';
import { loadCustomerReturnRequestMaterials } from '@/lib/orders/returns/customer-return-store';
import { RETURN_REASONS } from '@/lib/orders/returns/return-types';
import { estimateCustomerReturn } from '@/lib/orders/unit-pricing/unit-pricing-service';
import { UnitPricingError } from '@/lib/orders/unit-pricing/unit-pricing-types';

const bodySchema = z.object({
  lines: z
    .array(
      z.object({
        orderItemId: z.string().uuid(),
        quantity: z.number().int().min(1).max(999),
        // unknown（不明）はお店が昔の返品に付ける理由で、お客様には出さない
        reason: z.enum(RETURN_REASONS).exclude(['unknown']),
        requestedResolution: z.enum(['refund', 'exchange']),
      }),
    )
    .min(1)
    .max(100),
});

/**
 * 確かめる段に入る時に1回呼ぶ。ログインしたお客様の注文だけが読める（持ち主・お客様に隠す状態は DB の関数が確かめる）。
 * 読むだけなので CSRF と回数の制限は通さない（申し込みの材料を読む窓口と同じ）。POST なのは、選びを本文で渡すため。
 * 見込みを出せない時（選んだ行が注文に無い・枠が足りない）は、額を出さずに 409 を返す（申し込み自体は止めない）。
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const guard = await guardCustomerRead(request);
  if (!guard.ok) {
    return guard.response;
  }
  const orderId = parseOrderId((await params).id);
  if (!orderId) {
    return orderNotFoundResponse();
  }
  const parsedBody = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsedBody.success) {
    return invalidArgumentResponse();
  }

  try {
    const client = await createServiceRoleClient();
    const materials = await loadCustomerReturnRequestMaterials(client, { orderId, customerId: guard.customerId });
    if (!materials) {
      return orderNotFoundResponse();
    }
    // 申し込める品だけ（この注文の、返品できる品）を見込みに入れる。ほかの品が混ざった本文は申し込みの形の誤り
    const selectable = new Set(materials.shipments.flatMap((shipment) => shipment.lines.map((line) => line.orderItemId)));
    if (parsedBody.data.lines.some((line) => !selectable.has(line.orderItemId))) {
      return invalidArgumentResponse();
    }
    const estimate = await estimateCustomerReturn(client, orderId, parsedBody.data.lines);
    return customerJson({ data: estimate });
  } catch (error) {
    if (error instanceof UnitPricingError) {
      return customerJson({ error: '返金の見込みを出せませんでした。', code: 'ESTIMATE_UNAVAILABLE' }, 409);
    }
    return respondToCustomerReturnError(error, {
      audit: null,
      tag: 'account.orders.return.estimate',
      refusedDetail: 'Return estimate refused',
      failureDetail: 'Failed to estimate return refund',
    });
  }
}
