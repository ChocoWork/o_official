import { handleRefundCancellationPost } from '@/lib/accounting/return-refund-route';

/** 取り消された返金の区分（店が返金をやめた／返すつもり）を選ぶ。admin.accounting.entries.correct。応答の後に計上係を流す。 */
export async function POST(request: Request): Promise<Response> {
	return handleRefundCancellationPost(request);
}
