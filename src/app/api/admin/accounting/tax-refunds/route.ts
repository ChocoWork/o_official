import { handleTaxRefundsGet } from '@/lib/accounting/return-refund-route';

/** 消費税用の返金の一覧と合計（期間は月単位）。admin.finance.read、全応答 no-store。 */
export async function GET(request: Request): Promise<Response> {
	return handleTaxRefundsGet(request);
}
