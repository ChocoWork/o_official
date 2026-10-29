import { stopBodySchema } from '@/lib/discounts/admin-discount-schema';
import { setAdminDiscountStopped } from '@/lib/discounts/admin-discount-store';
import { handleDiscountWrite, type DiscountContext } from '@/lib/discounts/admin-discount-route';

/** 割引の再開。有効数と共有itemの検査は、再送を先に探すwriterが鍵の下で行う。 */
export async function POST(request: Request, context: DiscountContext): Promise<Response> {
  return handleDiscountWrite(request, context, {
    label: 'POST /api/admin/discounts/[id]/resume', action: 'admin.discounts.resume', withId: true, status: 200, schema: stopBodySchema,
    run: (client, actorId, id, body) => setAdminDiscountStopped(client, actorId, id as string, false, body.expectedVersion, body.requestKey),
    audit: (result) => ({ replayed: result.replayed }),
  });
}
