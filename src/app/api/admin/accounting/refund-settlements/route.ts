import { handleRefundSettlementPost } from '@/lib/accounting/return-refund-route';

/** やり直しの返金で、返せなかった返金の借りを結ぶ。admin.accounting.entries.correct。応答の後に計上係を流す。 */
export async function POST(request: Request): Promise<Response> {
	return handleRefundSettlementPost(request);
}
