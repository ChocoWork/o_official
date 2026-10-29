import { unassignBodySchema } from '@/lib/discounts/admin-discount-schema';
import { unassignAdminDiscount } from '@/lib/discounts/admin-discount-store';
import { handleDiscountWrite, type DiscountContext } from '@/lib/discounts/admin-discount-route';

/** 未使用の割り当てを外す。使用済みはDBが409で拒む。 */
export async function POST(request: Request, context: DiscountContext): Promise<Response> {
  return handleDiscountWrite(request, context, {
    label: 'POST /api/admin/discounts/[id]/unassign', action: 'admin.discounts.unassign', withId: true, status: 200, schema: unassignBodySchema,
    run: (client, actorId, id, body) => unassignAdminDiscount(client, actorId, id as string, body.codeId, body.userId, body.requestKey),
    audit: (result) => ({ changed_count: result.changedCount, replayed: result.replayed }),
  });
}
