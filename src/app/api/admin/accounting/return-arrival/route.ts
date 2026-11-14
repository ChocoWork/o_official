import { handleReturnArrivalGet, handleReturnArrivalPost } from '@/lib/accounting/return-refund-route';

/** 受け取りごとの届いた日と直しの跡（最大200件）。admin.orders.read、全応答 no-store。 */
export async function GET(request: Request): Promise<Response> {
	return handleReturnArrivalGet(request);
}

/** 届いた日を直す。admin.accounting.entries.correct。監査は受け取りの番号と結果だけ（理由の本文・日を入れない）。 */
export async function POST(request: Request): Promise<Response> {
	return handleReturnArrivalPost(request);
}
