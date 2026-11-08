import { handleReconciliationGet } from '@/lib/accounting/posting-route';

/**
 * 照合の読み口をそのまま返す。admin.finance.read、全応答 no-store。
 * kind=stripe-balance&through= / kind=stripe-fee&month= / kind=intake&from=&to=
 */
export async function GET(request: Request): Promise<Response> {
	return handleReconciliationGet(request);
}
