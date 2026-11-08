import { handleDeferredRevenueGet } from '@/lib/accounting/posting-route';

/** 繰り越した前受金の一覧と異常の一覧。admin.finance.read、全応答 no-store。 */
export async function GET(request: Request): Promise<Response> {
	return handleDeferredRevenueGet(request);
}
