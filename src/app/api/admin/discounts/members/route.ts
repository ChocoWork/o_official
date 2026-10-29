import { handleDiscountMembers } from '@/lib/discounts/admin-discount-route';

/** 割り当て用の会員検索（20件/回）。権限は admin.discounts.manage、IP60・actor60 / 600秒。 */
export async function GET(request: Request): Promise<Response> {
  return handleDiscountMembers(request);
}
