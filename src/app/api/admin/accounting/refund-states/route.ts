import { handleRefundStatesGet } from '@/lib/accounting/return-refund-route';

/** 取り消しの区分待ち・借りが残る返金の一覧（名前・メールを含めない）。admin.finance.read、全応答 no-store。 */
export async function GET(request: Request): Promise<Response> {
	return handleRefundStatesGet(request);
}
