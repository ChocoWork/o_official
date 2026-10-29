import { patchBodySchema } from '@/lib/discounts/admin-discount-schema';
import { updateAdminDiscount } from '@/lib/discounts/admin-discount-store';
import { handleDiscountDetail, handleDiscountWrite, type DiscountContext } from '@/lib/discounts/admin-discount-route';

/** 割引の詳細と割り当て表（20行/頁）。権限は admin.discounts.read。 */
export async function GET(request: Request, context: DiscountContext): Promise<Response> {
  return handleDiscountDetail(request, context);
}

/** 割引の編集。expectedVersion が合わなければ409。使用後に変えられる項目はDBが決める。 */
export async function PATCH(request: Request, context: DiscountContext): Promise<Response> {
  return handleDiscountWrite(request, context, {
    label: 'PATCH /api/admin/discounts/[id]', action: 'admin.discounts.update', withId: true, status: 200, schema: patchBodySchema,
    run: (client, actorId, id, body) => updateAdminDiscount(client, actorId, id as string, body.patch, body.expectedVersion, body.requestKey),
    audit: (result) => ({ replayed: result.replayed }),
  });
}
