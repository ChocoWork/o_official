import { createBodySchema } from '@/lib/discounts/admin-discount-schema';
import { createAdminDiscount } from '@/lib/discounts/admin-discount-store';
import { handleDiscountList, handleDiscountWrite } from '@/lib/discounts/admin-discount-route';

/** 割引の一覧。権限は admin.discounts.read、回数制限なし、全応答 no-store。 */
export async function GET(request: Request): Promise<Response> {
  return handleDiscountList(request);
}

/** 割引の作成。admin.discounts.manage。再送は同じ requestKey で同じ本文（201）。 */
export async function POST(request: Request): Promise<Response> {
  return handleDiscountWrite(request, null, {
    label: 'POST /api/admin/discounts', action: 'admin.discounts.create', withId: false, status: 201, schema: createBodySchema,
    run: (client, actorId, _id, body) => createAdminDiscount(client, actorId, body.input, body.requestKey),
    resultId: (result) => result.discountId,
    audit: (result) => ({ replayed: result.replayed }),
  });
}
