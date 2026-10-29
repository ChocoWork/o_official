import { assignBodySchema } from '@/lib/discounts/admin-discount-schema';
import { assignAdminDiscount } from '@/lib/discounts/admin-discount-store';
import { handleDiscountWrite, type DiscountContext } from '@/lib/discounts/admin-discount-route';

/** 共有コードへ会員を割り当てる（1〜100人、重複なし）。監査にはuserIdsの配列でなく件数だけを残す。 */
export async function POST(request: Request, context: DiscountContext): Promise<Response> {
  return handleDiscountWrite(request, context, {
    label: 'POST /api/admin/discounts/[id]/assign', action: 'admin.discounts.assign', withId: true, status: 200, schema: assignBodySchema,
    run: (client, actorId, id, body) => assignAdminDiscount(client, actorId, id as string, body.codeId, body.userIds, body.requestKey),
    audit: (result) => ({ changed_count: result.changedCount, replayed: result.replayed }),
  });
}
