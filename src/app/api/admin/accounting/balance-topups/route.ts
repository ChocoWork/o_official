import { handleBalanceTopupPost } from '@/lib/accounting/posting-route';

/** 残高の補充の記録。admin.finance.manage。同じ要求番号の再送は前の結果を返す。監査は結果だけ。 */
export async function POST(request: Request): Promise<Response> {
	return handleBalanceTopupPost(request);
}
