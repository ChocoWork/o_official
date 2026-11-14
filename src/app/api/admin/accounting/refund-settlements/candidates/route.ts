import { handleRefundSettleCandidatesGet } from '@/lib/accounting/return-refund-route';

/** やり直しの結びの候補（owedRefundId の借りを結べる、同じ注文の成功した返金。名前・メールを含めない）。admin.finance.read、全応答 no-store。 */
export async function GET(request: Request): Promise<Response> {
	return handleRefundSettleCandidatesGet(request);
}
