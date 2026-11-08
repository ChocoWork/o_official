import { handlePendingEventsGet } from '@/lib/accounting/posting-route';

/** 計上待ちの一覧（新しい順）。admin.finance.read、全応答 no-store。個人の情報を含めない。 */
export async function GET(request: Request): Promise<Response> {
	return handlePendingEventsGet(request);
}
