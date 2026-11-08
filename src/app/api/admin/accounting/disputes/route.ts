import { handleDisputesGet } from '@/lib/accounting/posting-route';

/** カード会社からの支払いの取り消しの一覧。admin.finance.read、全応答 no-store。 */
export async function GET(request: Request): Promise<Response> {
	return handleDisputesGet(request);
}
