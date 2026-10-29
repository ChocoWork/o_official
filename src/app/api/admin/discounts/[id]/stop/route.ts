import { stopBodySchema } from '@/lib/discounts/admin-discount-schema';
import { setAdminDiscountStopped } from '@/lib/discounts/admin-discount-store';
import { handleDiscountWrite, type DiscountContext } from '@/lib/discounts/admin-discount-route';

/** 割引の停止。有効数を増やさない。 */
export async function POST(request: Request, context: DiscountContext): Promise<Response> {
  return handleDiscountWrite(request, context, {
    label: 'POST /api/admin/discounts/[id]/stop', action: 'admin.discounts.stop', withId: true, status: 200, schema: stopBodySchema,
    run: (client, actorId, id, body) => setAdminDiscountStopped(client, actorId, id as string, true, body.expectedVersion, body.requestKey),
    audit: (result) => ({ replayed: result.replayed }),
  });
}
