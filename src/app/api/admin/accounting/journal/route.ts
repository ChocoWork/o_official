import { handleJournalGet } from '@/lib/accounting/accounting-route';

/** 期間の保存した仕訳（日→通し番号の順、続きは日と番号の組）と期首の残高。admin.finance.read、全応答 no-store。 */
export async function GET(request: Request): Promise<Response> {
	return handleJournalGet(request);
}
