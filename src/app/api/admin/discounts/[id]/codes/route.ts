import { codesBodySchema } from '@/lib/discounts/admin-discount-schema';
import { generateAdminDiscountCodes } from '@/lib/discounts/admin-discount-store';
import { handleDiscountWrite, type DiscountContext } from '@/lib/discounts/admin-discount-route';

/** 使い捨てコードの束（1〜100）。書込の制限に加えて admin.discounts.codes（IP10・actor10 / 600秒）。 */
export async function POST(request: Request, context: DiscountContext): Promise<Response> {
  return handleDiscountWrite(request, context, {
    label: 'POST /api/admin/discounts/[id]/codes', action: 'admin.discounts.generate_codes', withId: true, codesLimit: true, status: 201, schema: codesBodySchema,
    run: (client, actorId, id, body) => generateAdminDiscountCodes(client, actorId, id as string, body.prefix, body.userIds, body.count, body.requestKey),
    audit: (result) => ({ generated_count: result.codes.length, replayed: result.replayed }),
  });
}
