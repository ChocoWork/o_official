import { handleRefundBankTransferPost } from '@/lib/accounting/return-refund-route';

/** 振込で返した分の記録。admin.finance.manage。同じ要求番号の再送は前の結果。監査は結果だけ。応答の後に計上係を流す。 */
export async function POST(request: Request): Promise<Response> {
	return handleRefundBankTransferPost(request);
}
