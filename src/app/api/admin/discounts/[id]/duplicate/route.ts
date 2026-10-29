import { duplicateBodySchema } from '@/lib/discounts/admin-discount-schema';
import { duplicateAdminDiscount } from '@/lib/discounts/admin-discount-store';
import { handleDiscountWrite, type DiscountContext } from '@/lib/discounts/admin-discount-route';

/** 割引の複製。複製は停止状態で作られる。 */
export async function POST(request: Request, context: DiscountContext): Promise<Response> {
  return handleDiscountWrite(request, context, {
    label: 'POST /api/admin/discounts/[id]/duplicate', action: 'admin.discounts.duplicate', withId: true, status: 201, schema: duplicateBodySchema,
    run: (client, actorId, id, body) => duplicateAdminDiscount(client, actorId, id as string, body.requestKey),
    // 成功の監査は、新しくできた割引のidを resource_id に残す（複製元はURLから分かる）。
    resultId: (result) => result.discountId,
    audit: (result) => ({ replayed: result.replayed }),
  });
}
